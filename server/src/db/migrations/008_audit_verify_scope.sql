-- ─────────────────────────────────────────────────────────────────────────────
-- Make audit_log_verify() actually verify the audit log.
--
-- THE BUG, in full, because it is the most instructive kind: a security control
-- that reported success by never looking.
--
-- `audit_log_verify()` walks audit_log from the earliest row forward, checking
-- each entry's digest against the one before it. It was created as a plain
-- (INVOKER) function, so it read the table as whoever called it — and audit_log
-- carries `tenant_isolation` from migration 001 under FORCE ROW LEVEL SECURITY.
--
-- The consequences, both directions:
--
--   * Called by app_user with no tenant context — which is what an unattended
--     verification job does — the policy matched NO rows. The loop body never
--     executed. The function returned zero rows, which is its signal for "the
--     log is intact". A scheduled integrity check would have reported a healthy
--     chain every single day, on a log that had been rewritten wholesale.
--
--   * Called with a tenant context, which is what the /api/audit/integrity
--     route does, it saw only that tenant's entries. Two failure modes at once:
--     it cannot see tampering in another firm's rows and calls the log intact,
--     AND — because the chain interleaves tenants — entry 7's prev_hash points
--     at entry 6, which belongs to a different firm and is invisible, so the
--     check reports a break on a perfectly healthy log the moment two firms are
--     active at the same time. Wrong when the log is fine, wrong when it is not.
--
-- The existing tests did not catch either one. They call the function over the
-- superuser connection the fixtures use for setup, which bypasses row level
-- security entirely and therefore exercised the one path no deployed caller
-- ever takes. The tests were right about the SQL and silent about the access
-- path, which is the shape most of these gaps have.
--
-- THE FIX has two halves, and neither works alone:
--
--   1. SECURITY DEFINER, so the function reads as its owner rather than as the
--      caller. On its own this is not enough — audit_log is FORCE ROW LEVEL
--      SECURITY, which subjects the owner to the policies too, so the owner
--      would see nothing either.
--   2. A policy admitting the owner to SELECT. This grants nothing new in
--      substance: the table's owner can already `ALTER TABLE ... NO FORCE` and
--      read everything. It makes an existing capability explicit, narrow
--      (SELECT only) and visible in pg_policies, rather than leaving it
--      implicit and switched off.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not let a tenant read another
-- tenant's audit entries. The function's return type is (broken_at bigint,
-- reason text) — an id and one of three fixed strings. No entry content can
-- come back through it, whatever the caller. The route above it returns even
-- less: `intact` and `reason`, never the id.
-- ─────────────────────────────────────────────────────────────────────────────

-- The owner needs SELECT on audit_log for the definer function to read it.
-- TO CURRENT_USER resolves at creation time to the role running the migration,
-- which is the role that owns the table and the function — `cre_owner` in AWS,
-- whatever the fixtures use locally. Naming a role literally here would work in
-- exactly one environment.
DROP POLICY IF EXISTS audit_log_owner_read ON audit_log;
CREATE POLICY audit_log_owner_read ON audit_log
  FOR SELECT TO CURRENT_USER
  USING (true);

-- SECURITY DEFINER, with search_path pinned. An unpinned search_path on a
-- definer function is the classic escalation: a caller who can create objects
-- prepends a schema and the function resolves `audit_log` to a table of their
-- own.
--
-- STABLE is retained: the function performs no writes, and marking it VOLATILE
-- would prevent the planner from treating repeated calls sensibly for no gain.
ALTER FUNCTION audit_log_verify(bigint) SECURITY DEFINER;
ALTER FUNCTION audit_log_verify(bigint) SET search_path = public;

-- EXECUTE stays granted to app_user (migration 003). That grant is what lets
-- both the admin integrity route and the scheduled verification job call it
-- without holding the owner credential — which is the point: an unattended job
-- that needs owner rights to check the audit log is a job that hands an
-- attacker the owner credential.
