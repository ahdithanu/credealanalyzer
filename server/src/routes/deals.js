'use strict';

const express = require('express');
const { withTenant } = require('../db/pool');
const { requireRole } = require('../middleware/requireSession');

/**
 * Deal CRUD.
 *
 * Note what is NOT in any query below: a `WHERE tenant_id = $n` predicate.
 * That is deliberate and it is the payoff of doing isolation in the database —
 * row level security adds it, on every statement, whether or not the person
 * writing the route remembered. A route that forgets returns nothing rather
 * than another firm's pipeline, and isolation.test.js proves that against a
 * real engine.
 *
 * `withTenant` takes its tenant from `req.session`, which came from the
 * identity provider's assertion. No handler here reads a tenant from the
 * request, and none may.
 */

const MAX_PAYLOAD_BYTES = 512 * 1024;

/** Reject an oversized or malformed deal before it reaches the database. */
function validateDeal(body) {
  const errors = [];
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) errors.push('name is required');
  if (name.length > 200) errors.push('name must be 200 characters or fewer');

  if (body?.payload === undefined || body.payload === null || typeof body.payload !== 'object') {
    errors.push('payload must be an object');
  } else if (Buffer.byteLength(JSON.stringify(body.payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    errors.push('payload is too large');
  }

  const stage = body?.stage === undefined || body.stage === null ? null : String(body.stage);
  if (stage && stage.length > 60) errors.push('stage must be 60 characters or fewer');

  return { errors, name, stage, payload: body?.payload };
}

const audit = (db, req, action, subjectId, detail) => db.query(
  `INSERT INTO audit_log (tenant_id, actor_user_id, action, subject_type, subject_id, detail, ip)
   VALUES ($1,$2,$3,'deal',$4,$5,$6)`,
  [req.session.tenantId, req.session.userId, action, subjectId,
    detail ? JSON.stringify(detail) : null, req.ip || null],
);

function dealRoutes() {
  const r = express.Router();

  r.get('/', async (req, res, next) => {
    try {
      const rows = await withTenant(req.session.tenantId, req.session.userId, async (db) => {
        const q = await db.query(
          `SELECT id, name, stage, payload, created_at, updated_at
             FROM deals WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500`,
        );
        return q.rows;
      });
      res.json({ deals: rows });
    } catch (err) { next(err); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const row = await withTenant(req.session.tenantId, req.session.userId, async (db) => {
        const q = await db.query(
          `SELECT id, name, stage, payload, created_at, updated_at
             FROM deals WHERE id = $1 AND deleted_at IS NULL`,
          [req.params.id],
        );
        return q.rows[0] || null;
      });
      // 404, not 403. Telling an outsider that a deal id EXISTS but belongs to
      // someone else is itself a disclosure — it confirms a competitor is
      // working on something.
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ deal: row });
    } catch (err) { next(err); }
  });

  r.post('/', requireRole('analyst', 'vp', 'admin'), async (req, res, next) => {
    try {
      const { errors, name, stage, payload } = validateDeal(req.body);
      if (errors.length) { res.status(400).json({ error: 'invalid', errors }); return; }

      const deal = await withTenant(req.session.tenantId, req.session.userId, async (db) => {
        const q = await db.query(
          `INSERT INTO deals (tenant_id, name, stage, payload, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$5)
           RETURNING id, name, stage, payload, created_at, updated_at`,
          [req.session.tenantId, name, stage, payload, req.session.userId],
        );
        await audit(db, req, 'deal.created', q.rows[0].id, { name });
        return q.rows[0];
      });
      res.status(201).json({ deal });
    } catch (err) { next(err); }
  });

  r.put('/:id', requireRole('analyst', 'vp', 'admin'), async (req, res, next) => {
    try {
      const { errors, name, stage, payload } = validateDeal(req.body);
      if (errors.length) { res.status(400).json({ error: 'invalid', errors }); return; }

      const deal = await withTenant(req.session.tenantId, req.session.userId, async (db) => {
        const q = await db.query(
          `UPDATE deals
              SET name = $2, stage = $3, payload = $4, updated_by = $5, updated_at = now()
            WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, name, stage, payload, created_at, updated_at`,
          [req.params.id, name, stage, payload, req.session.userId],
        );
        if (!q.rows[0]) return null;
        await audit(db, req, 'deal.updated', q.rows[0].id, { name });
        return q.rows[0];
      });
      if (!deal) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ deal });
    } catch (err) { next(err); }
  });

  r.delete('/:id', requireRole('vp', 'admin'), async (req, res, next) => {
    try {
      // Soft delete: an IC memo that cited a deal must still resolve it, and an
      // analyst deleting the wrong row should be recoverable.
      const ok = await withTenant(req.session.tenantId, req.session.userId, async (db) => {
        const q = await db.query(
          `UPDATE deals SET deleted_at = now(), updated_by = $2
            WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
          [req.params.id, req.session.userId],
        );
        if (!q.rows[0]) return false;
        await audit(db, req, 'deal.deleted', q.rows[0].id, null);
        return true;
      });
      if (!ok) { res.status(404).json({ error: 'not_found' }); return; }
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return r;
}

module.exports = { dealRoutes, validateDeal };
