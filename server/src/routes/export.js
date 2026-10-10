'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { withTenant } = require('../db/pool');
const { requireRole } = require('../middleware/requireSession');
const { keyFor, readPayload } = require('../crypto/keyring');

/**
 * Tenant data export — the portability answer.
 *
 * "How do we get our data back if you fold" is a question every solo vendor is
 * asked, and until now the only answer was the CSV button in the SPA, which
 * serialises whatever deals the page happens to have already loaded. That is a
 * screenshot, not an archive: it omits soft-deleted deals, users, firm defaults
 * and the entire audit trail, and it silently truncates at whatever the list
 * endpoint returned.
 *
 * This is the archive: every row the tenant owns, in one JSON document.
 *
 * ─── IT STREAMS ──────────────────────────────────────────────────────────────
 *
 * Built row by row from server-side CURSORS and written straight to the socket.
 * Buffering the archive first would mean a firm with years of deals needs its
 * whole history resident in memory at once — and since any admin can call this,
 * an endpoint that does that is a denial of service with an authentication
 * prompt in front of it. Nothing here accumulates: `write()` respects
 * backpressure, so a slow client slows the export instead of filling the heap.
 *
 * ─── THE AUDIT ENTRY IS WRITTEN AND COMMITTED FIRST ──────────────────────────
 *
 * In its own transaction, before a single byte leaves. An export that fails
 * halfway still disclosed everything it managed to send, so an entry written on
 * success is an entry that is missing from exactly the incidents worth
 * investigating — the interrupted export, the aborted one, the one that died
 * because someone pulled the plug on it mid-transfer. Writing it first means the
 * log can over-report (an export that was authorised and then failed at byte
 * zero) and never under-report. Over-reporting is the survivable direction.
 */

const FETCH = 200;

/** A cursor name is a SQL identifier and can never be interpolated from input;
 *  these are the only four, and they are constants. */
const SECTIONS = [
  {
    key: 'deals',
    cursor: 'export_deals',
    // Soft-deleted deals are INCLUDED. A firm taking its data out is entitled to
    // the rows it deleted as much as the ones it kept — and an archive that
    // quietly drops them is one where "we exported everything" is false.
    sql: `SELECT id, name, stage, payload, payload_ct, created_by, updated_by,
                 created_at, updated_at, deleted_at
            FROM deals ORDER BY created_at, id`,
  },
  {
    key: 'users',
    cursor: 'export_users',
    sql: `SELECT id, email, name, external_id, role, last_login_at, created_at
            FROM users ORDER BY created_at, id`,
  },
  {
    key: 'firmDefaults',
    cursor: 'export_firm_defaults',
    sql: `SELECT id, version, assumptions, approved_by, approved_at, created_at
            FROM firm_defaults ORDER BY created_at, id`,
  },
  {
    key: 'auditLog',
    cursor: 'export_audit',
    // Platform rows (tenant_id NULL) are invisible to a tenant under the policy
    // from 001, so this is the firm's own trail and no one else's.
    sql: `SELECT id, action, subject_type, subject_id, detail, actor_kind,
                 actor_ref, actor_user_id, ip, at
            FROM audit_log ORDER BY id`,
  },
];

function exportRoutes() {
  const r = express.Router();

  r.get('/', requireRole('admin'), async (req, res, next) => {
    const { tenantId, userId } = req.session;
    const exportId = crypto.randomUUID();
    let started = false;

    try {
      // ─── 1. The record, committed on its own ────────────────────────────
      // A SEPARATE withTenant, deliberately. Putting this in the streaming
      // transaction would tie it to that transaction's fate: the stream throws,
      // withTenant rolls back, and the disclosure that already reached the wire
      // leaves no trace at all. That is the precise failure this ordering
      // exists to prevent, so the two must not share a transaction.
      await withTenant(tenantId, userId, (db) => db.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, subject_type, subject_id, detail, ip)
         VALUES ($1,$2,'tenant.exported','tenant',$3,$4,$5)`,
        [tenantId, userId, tenantId,
          JSON.stringify({ exportId, sections: SECTIONS.map((s) => s.key) }),
          req.ip || null],
      ));

      // ─── 2. The archive ─────────────────────────────────────────────────
      const slug = String(req.session.tenant?.slug || 'tenant').replace(/[^a-z0-9-]/gi, '');
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="${slug}-export-${stamp}.json"`);
      // No length is known in advance — that is what streaming means — so the
      // client gets chunked encoding and finds out it is done when the document
      // closes.
      started = true;

      let aborted = false;
      req.on('aborted', () => { aborted = true; });
      res.on('close', () => { aborted = true; });

      /**
       * Write, and wait when the socket is full. The `await` here is the entire
       * reason this endpoint cannot be used to exhaust memory.
       *
       * The listeners are removed on both outcomes. A slow client produces one
       * of these waits per chunk, and `once` handlers that are never invoked
       * accumulate on the response — the export that most needs backpressure is
       * the one that would otherwise leak a listener per batch and warn about
       * it halfway through.
       */
      const write = (chunk) => new Promise((resolve, reject) => {
        if (aborted) { reject(new Error('client went away')); return; }
        if (res.write(chunk)) { resolve(); return; }
        const done = () => { res.off('drain', onDrain); res.off('close', onGone); res.off('error', onGone); };
        const onDrain = () => { done(); resolve(); };
        // Without this the promise would never settle when a stalled client
        // disappears, and the transaction would sit open until Postgres killed
        // it — a pooled connection lost to a reader that walked away.
        const onGone = () => { done(); reject(new Error('client went away')); };
        res.on('drain', onDrain);
        res.on('close', onGone);
        res.on('error', onGone);
      });

      const counts = {};

      await withTenant(tenantId, userId, async (db) => {
        // A cursor holds this connection for as long as the client takes to
        // read. `statement_timeout` does not help — each FETCH is fast and the
        // waiting happens between them — so this is the bound that actually
        // applies to a stalled reader, and it releases a pooled connection that
        // would otherwise be hostage to a client that stopped reading.
        await db.query('SET LOCAL idle_in_transaction_session_timeout = 60000');

        // EVERY CURSOR IS OPENED BEFORE ANY IS FETCHED. Under READ COMMITTED a
        // cursor takes its snapshot when it is opened, so opening them together
        // is what keeps the sections from drifting apart while a long export
        // runs. An archive whose `users` section is an hour newer than its
        // `deals` section is not a snapshot of anything, and the deal that
        // references a user who does not appear is the bug that gets reported.
        for (const s of SECTIONS) {
          await db.query(`DECLARE ${s.cursor} NO SCROLL CURSOR FOR ${s.sql}`);
        }

        await write(`{"manifest":${JSON.stringify({
          schemaVersion: 1,
          exportId,
          generatedAt: new Date().toISOString(),
          tenant: req.session.tenant,
          exportedBy: { userId, email: req.session.email },
          includes: {
            softDeletedDeals: true,
            auditTrail: true,
            // Said plainly, because the absence is otherwise invisible: session
            // rows are not the tenant's data to take, and they are not readable
            // by this role at all (migration 002).
            sessions: false,
          },
          notes: [
            'Deals carry "deleted": true when they were soft-deleted; "deletedAt" says when.',
            'A deal payload that could not be read is null with a "payloadError" reason. '
              + 'It is never omitted and never rendered as an empty object.',
            'The document ends with "complete": true. An archive without it was truncated.',
          ],
        })}`);

        // The tenant data key, fetched at most once for the whole archive and
        // only if some deal actually needs it.
        let keyState = null;

        for (const section of SECTIONS) {
          await write(`,\n"${section.key}":[`);
          let n = 0;
          for (;;) {
            const batch = await db.query(`FETCH ${FETCH} FROM ${section.cursor}`);
            if (!batch.rows.length) break;

            // Resolve the key on the first batch that ACTUALLY CONTAINS
            // ciphertext, not on the first batch full stop.
            //
            // keyFor() returns a truthy {key: null, keyError: null} when no row
            // in the batch needs a key, so `!keyState` was false from the first
            // batch onward and the tenant key was never fetched. Any encrypted
            // deal outside the first 200 rows exported as payload: null — while
            // the archive still ended "complete": true.
            //
            // That is the DEFAULT state of every existing tenant between the
            // 005 deploy and the backfill: legacy plaintext rows sort first, so
            // the newly encrypted deals are exactly the ones past the batch
            // boundary. A portability archive quietly missing the underwriting
            // models it exists to deliver.
            if (section.key === 'deals'
                && keyState === null
                && batch.rows.some((r) => r.payload_ct != null)) {
              keyState = await keyFor(db, tenantId, batch.rows);
            }

            for (const row of batch.rows) {
              const record = section.key === 'deals'
                ? dealRecord(tenantId, row, keyState)
                : row;
              await write((n === 0 ? '' : ',') + JSON.stringify(record));
              n += 1;
            }
          }
          counts[section.key] = n;
          await write(']');
        }

        // Counts last, because they are only known last — and `complete` after
        // them, so a reader can tell a finished archive from a connection that
        // died. A truncated JSON document will not parse, which is the honest
        // outcome; this makes the check possible without parsing.
        await write(`,\n"counts":${JSON.stringify(counts)},\n"complete":true}\n`);
      });

      res.end();
    } catch (err) {
      if (!started) { next(err); return; }
      // The headers and a 200 are already on the wire, so there is no status
      // code left to change and no way to send an error body that a client
      // would not mistake for archive content. Destroy the socket instead: the
      // consumer sees a truncated transfer, the document has no closing brace
      // and no "complete" marker, and the audit entry written in step 1 records
      // that the export was attempted.
      console.error(JSON.stringify({
        level: 'error', msg: 'export stream failed', exportId,
        tenant: tenantId, err: err.message,
      }));
      res.destroy();
    }
  });

  return r;
}

/**
 * One deal, in the archive's shape.
 *
 * `payload_ct` NEVER appears in the output. The ciphertext column is read, used,
 * and dropped here; what the customer receives is the underwriting model or an
 * explicit statement that it could not be produced.
 */
function dealRecord(tenantId, row, keyState) {
  const { payload, payloadError } = readPayload(
    tenantId, row, keyState?.key || null, keyState?.keyError || null);
  const out = {
    id: row.id,
    name: row.name,
    stage: row.stage,
    payload,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Marked rather than filtered. A row the firm deleted is still the firm's.
    deleted: row.deleted_at !== null,
    deletedAt: row.deleted_at,
  };
  if (payloadError) out.payloadError = payloadError;
  return out;
}

module.exports = { exportRoutes, __internals: { dealRecord, SECTIONS } };
