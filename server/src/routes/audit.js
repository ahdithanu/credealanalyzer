'use strict';

const express = require('express');
const { withTenant } = require('../db/pool');
const { requireRole } = require('../middleware/requireSession');

/**
 * The customer-visible audit trail.
 *
 * A trail the customer cannot read is a trail that serves only us. Enterprise
 * buyers require visibility, and a firm investigating its own insider incident —
 * who exported the pipeline the week an analyst resigned — needs it more than we
 * ever will.
 *
 * Row level security scopes every query to the caller's tenant, so no handler
 * here carries a tenant predicate. Platform events (tenant_id NULL) are
 * invisible to every tenant by construction: "a different firm was suspended"
 * is not their business.
 *
 * Restricted to admin and vp. An audit log names who did what, and on a small
 * deal team that is close to reading your colleagues' activity — appropriate
 * for someone accountable for the team, not for everyone in it.
 */

const MAX_LIMIT = 500;

function auditRoutes() {
  const r = express.Router();

  r.get('/', requireRole('admin', 'vp'), async (req, res, next) => {
    try {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 100));
      // Keyset pagination on a monotonic id rather than OFFSET: an append-only
      // log grows under the reader, and OFFSET silently skips or repeats rows
      // as it does.
      const before = req.query.before ? Number(req.query.before) : null;
      if (before !== null && !Number.isFinite(before)) {
        res.status(400).json({ error: 'invalid', errors: ['before must be a number'] });
        return;
      }

      const action = typeof req.query.action === 'string' ? req.query.action.slice(0, 60) : null;

      const rows = await withTenant(req.session.tenantId, req.session.userId, async (db) => {
        const q = await db.query(
          `SELECT a.id, a.action, a.subject_type, a.subject_id, a.detail,
                  a.actor_kind, a.actor_ref, a.ip, a.at,
                  u.email AS actor_email, u.name AS actor_name
             FROM audit_log a
             LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE ($1::bigint IS NULL OR a.id < $1)
              AND ($2::text IS NULL OR a.action = $2)
            ORDER BY a.id DESC
            LIMIT $3`,
          [before, action, limit],
        );
        return q.rows;
      });

      res.json({
        entries: rows,
        // The cursor for the next page, or null at the end. Stated rather than
        // left for the caller to derive from the last row.
        nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
      });
    } catch (err) { next(err); }
  });

  /**
   * Prove the log has not been altered.
   *
   * Recomputes the hash chain in the database. This does not PREVENT tampering —
   * anyone with the owner credential can edit a row — it makes tampering
   * detectable, which is the honest property to claim for an audit log.
   *
   * The chain is global across tenants, so a tenant-scoped caller learns only
   * whether it is intact, never the id or contents of a foreign row.
   */
  r.get('/integrity', requireRole('admin'), async (req, res, next) => {
    try {
      const broken = await withTenant(req.session.tenantId, req.session.userId, async (db) => {
        const q = await db.query('SELECT broken_at, reason FROM audit_log_verify()');
        return q.rows[0] || null;
      });
      res.json(broken
        ? { intact: false, reason: broken.reason }
        : { intact: true, verifiedAt: new Date().toISOString() });
    } catch (err) { next(err); }
  });

  return r;
}

module.exports = { auditRoutes };
