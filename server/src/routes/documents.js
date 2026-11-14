'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { withTenant } = require('../db/pool');
const { requireRole } = require('../middleware/requireSession');
const { tenantDataKey } = require('../crypto/keyring');
const envelope = require('../crypto/envelope');
const { extractPages, isPdfMagic, PdfError } = require('../documents/pdfText');

/**
 * Documents attached to a deal, mounted at /api/deals/:dealId/documents.
 *
 *   POST /   the raw PDF as the body, Content-Type application/pdf, and the
 *            file's name URL-encoded in X-Filename. Stores per-page text.
 *   GET  /   metadata for every document on the deal (no page text).
 *   GET  /:docId  one document with its pages (contract C1).
 *
 * As in routes/deals.js, no query carries a tenant predicate: row level
 * security on deal_documents (migration 012, via apply_tenant_isolation) adds
 * it. The tenant comes from the session and from nowhere else.
 *
 * A deal or document that belongs to another firm is a 404, exactly like one
 * that does not exist. A 403 would confirm the id is real.
 *
 * The upload body gets its OWN parser with its own ceiling, on this route
 * only. The global `express.json({ limit: '1mb' })` in app.js is untouched and
 * does not claim application/pdf, so it never sees these bytes.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILENAME = 255;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client's file name, from X-Filename (URL-encoded, because a header
 * cannot carry arbitrary Unicode). Only the last path segment is kept, and a
 * name that is empty, too long or carries control characters is refused
 * rather than repaired: a stored name should be what the user picked.
 */
function parseFilename(header) {
  if (typeof header !== 'string' || header === '') return null;
  let name;
  try { name = decodeURIComponent(header); } catch { return null; }
  name = name.split(/[\\/]/).pop().trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > MAX_FILENAME || /[\u0000-\u001f\u007f]/u.test(name)) return null;
  return name;
}

const sealJson = (key, tenantId, value) =>
  envelope.seal(key, tenantId, Buffer.from(JSON.stringify(value), 'utf8'));
const openJson = (key, tenantId, blob) =>
  JSON.parse(envelope.open(key, tenantId, Buffer.from(blob)).toString('utf8'));

/** The metadata half of contract C1. `filename` is null, with a reason, if it
 *  cannot be opened: never a placeholder that reads like a real name. */
function presentMeta(row, key, keyError) {
  let filename = null;
  let filenameError;
  if (!key) filenameError = keyError || 'key_unavailable';
  else {
    try { filename = openJson(key, row.tenant_id, row.filename_ct); } catch { filenameError = 'decrypt_failed'; }
  }
  const out = {
    id: row.id,
    dealId: row.deal_id,
    filename,
    sha256: row.sha256,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    textLayer: row.text_layer,
    createdAt: new Date(row.created_at).toISOString(),
  };
  if (filenameError) out.filenameError = filenameError;
  return out;
}

async function keyOrError(db, tenantId) {
  try {
    return { key: await tenantDataKey(db, tenantId), keyError: null };
  } catch (err) {
    return { key: null, keyError: err.code === 'key_destroyed' ? 'key_destroyed' : 'key_unavailable' };
  }
}

/** A live (not soft-deleted) deal visible to this tenant, or null. */
async function liveDeal(db, dealId) {
  const q = await db.query('SELECT id FROM deals WHERE id = $1 AND deleted_at IS NULL', [dealId]);
  return q.rows[0] || null;
}

// The audit write. Same shape as routes/deals.js,
// with a document subject. The detail carries sizes and counts, never the file
// name: the audit log is not encrypted and outlives an offboarding.
const audit = (db, req, action, subjectId, detail) => db.query(
  `INSERT INTO audit_log (tenant_id, actor_user_id, action, subject_type, subject_id, detail, ip)
   VALUES ($1,$2,$3,'document',$4,$5,$6)`,
  [req.session.tenantId, req.session.userId, action, subjectId,
    detail ? JSON.stringify(detail) : null, req.ip || null],
);

const META_COLUMNS = 'id, tenant_id, deal_id, filename_ct, sha256, byte_size, page_count, text_layer, created_at';

/** express.raw with its own limit, and its errors answered here as codes. */
function pdfBody() {
  const parse = express.raw({ type: 'application/pdf', limit: MAX_BYTES });
  return (req, res, next) => {
    if (!req.is('application/pdf')) {
      res.status(415).json({ error: 'unsupported_media_type', expected: 'application/pdf' });
      return;
    }
    parse(req, res, (err) => {
      if (!err) { next(); return; }
      if (err.type === 'entity.too.large') {
        res.status(413).json({ error: 'too_large', limitBytes: MAX_BYTES });
        return;
      }
      next(err);
    });
  };
}

function documentRoutes() {
  const r = express.Router({ mergeParams: true });

  // Every route here is under one deal. A malformed id cannot name a deal, so
  // it is a 404 here rather than a Postgres cast error surfacing as a 500.
  r.use((req, res, next) => {
    if (!UUID.test(req.params.dealId || '')) { res.status(404).json({ error: 'not_found' }); return; }
    next();
  });

  // Role first, body second: a reader is refused before the server buffers
  // 25MB on their behalf.
  r.post('/', requireRole('analyst', 'vp', 'admin'), pdfBody(), async (req, res, next) => {
    try {
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        res.status(400).json({ error: 'empty' });
        return;
      }
      // Magic bytes, not the Content-Type header and not the file extension,
      // both of which the client chooses.
      if (!isPdfMagic(bytes)) {
        res.status(415).json({ error: 'not_pdf' });
        return;
      }
      const filename = parseFilename(req.headers['x-filename']);
      if (!filename) {
        res.status(400).json({ error: 'filename_required' });
        return;
      }

      const { tenantId, userId } = req.session;
      const dealId = req.params.dealId;

      // Checked before parsing, so a request naming another firm's deal (or
      // none) costs no PDF work. Checked again at insert, in the transaction
      // that writes, because the deal may be deleted in between.
      const exists = await withTenant(tenantId, userId, (db) => liveDeal(db, dealId));
      if (!exists) { res.status(404).json({ error: 'not_found' }); return; }

      // Parsed OUTSIDE any transaction: a large document must not hold a
      // pooled connection for the length of its parse.
      let extracted;
      try {
        extracted = await extractPages(bytes);
      } catch (err) {
        if (err instanceof PdfError) {
          console.error(JSON.stringify({ level: 'warn', msg: 'pdf refused', code: err.code, detail: err.message, tenant: tenantId }));
          res.status(422).json({ error: err.code });
          return;
        }
        throw err;
      }

      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

      const result = await withTenant(tenantId, userId, async (db) => {
        if (!await liveDeal(db, dealId)) return { status: 404 };
        const key = await tenantDataKey(db, tenantId);
        const q = await db.query(
          `INSERT INTO deal_documents
             (tenant_id, deal_id, filename_ct, pages_ct, sha256, byte_size, page_count, text_layer, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (deal_id, sha256) DO NOTHING
           RETURNING ${META_COLUMNS}`,
          [tenantId, dealId, sealJson(key, tenantId, filename), sealJson(key, tenantId, extracted.pages),
            sha256, bytes.length, extracted.pageCount, extracted.textLayer, userId],
        );
        if (!q.rows[0]) {
          const dup = await db.query(
            'SELECT id FROM deal_documents WHERE deal_id = $1 AND sha256 = $2', [dealId, sha256]);
          return { status: 409, documentId: dup.rows[0]?.id ?? null };
        }
        await audit(db, req, 'document.uploaded', q.rows[0].id, {
          dealId, byteSize: bytes.length, pageCount: extracted.pageCount, textLayer: extracted.textLayer,
        });
        return { status: 201, document: presentMeta(q.rows[0], key, null) };
      });

      if (result.status === 404) { res.status(404).json({ error: 'not_found' }); return; }
      if (result.status === 409) {
        // The same bytes are already on this deal. Said so, with the id, rather
        // than silently storing a second copy.
        res.status(409).json({ error: 'duplicate', documentId: result.documentId });
        return;
      }
      res.status(201).json(result.document);
    } catch (err) { next(err); }
  });

  r.get('/', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session;
      const out = await withTenant(tenantId, userId, async (db) => {
        if (!await liveDeal(db, req.params.dealId)) return null;
        const q = await db.query(
          `SELECT ${META_COLUMNS} FROM deal_documents WHERE deal_id = $1 ORDER BY created_at, id`,
          [req.params.dealId],
        );
        if (!q.rows.length) return [];
        // One key fetch for the page of results.
        const { key, keyError } = await keyOrError(db, tenantId);
        return q.rows.map((row) => presentMeta(row, key, keyError));
      });
      if (!out) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ documents: out });
    } catch (err) { next(err); }
  });

  r.get('/:docId', async (req, res, next) => {
    try {
      if (!UUID.test(req.params.docId || '')) { res.status(404).json({ error: 'not_found' }); return; }
      const { tenantId, userId } = req.session;
      const out = await withTenant(tenantId, userId, async (db) => {
        if (!await liveDeal(db, req.params.dealId)) return null;
        const q = await db.query(
          `SELECT ${META_COLUMNS}, pages_ct FROM deal_documents WHERE id = $1 AND deal_id = $2`,
          [req.params.docId, req.params.dealId],
        );
        const row = q.rows[0];
        if (!row) return null;
        const { key, keyError } = await keyOrError(db, tenantId);
        if (!key) return { error: keyError };
        let pages;
        try { pages = openJson(key, tenantId, row.pages_ct); } catch { return { error: 'decrypt_failed' }; }
        const meta = presentMeta(row, key, null);
        return { document: { ...meta, pages } };
      });
      if (!out) { res.status(404).json({ error: 'not_found' }); return; }
      if (out.error) {
        // The text cannot be opened. Never an empty `pages`, which would read
        // as "this document has no text" and is a different, false claim.
        res.status(out.error === 'key_destroyed' ? 410 : 500).json({ error: out.error });
        return;
      }
      res.json(out.document);
    } catch (err) { next(err); }
  });

  return r;
}

module.exports = { documentRoutes, parseFilename, MAX_BYTES };
