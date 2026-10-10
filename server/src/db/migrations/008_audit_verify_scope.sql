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

-- ─────────────────────────────────────────────────────────────────────────────
-- And the operator must be able to WRITE the operator's audit trail.
--
-- The same superuser fixture hid a second bug here, in the control the code
-- above recordAdmin() calls "the single worst gap in the system": administrative
-- actions — creating a tenant, verifying the email domain that admits an entire
-- firm to its data — were made auditable, through a code path that cannot write
-- an audit row on the platform it deploys to.
--
-- The admin tools connect with the OWNER credential and set no tenant context,
-- so tenant_isolation's WITH CHECK (tenant_id = current_tenant_id()) rejects
-- every row they try to write. Against a superuser it never came up. Against
-- `cre_owner` on RDS, every administrative action would have printed
-- "WARNING: the action succeeded but was not audited" and carried on — a
-- best-effort audit write, degrading to no audit at all, for exactly the
-- actions with no other record.
--
-- INSERT only. There is deliberately NO owner policy for UPDATE or DELETE, and
-- that absence is the point: the hash chain's promise is that altering history
-- is detectable, and a policy letting the owner edit rows would be a blessed
-- path to doing it. The owner can still `ALTER TABLE ... NO FORCE` and reach
-- the table anyway — but that is a deliberate, visible act of schema surgery,
-- not a thing an ordinary statement does by accident.
DROP POLICY IF EXISTS audit_log_owner_write ON audit_log;
CREATE POLICY audit_log_owner_write ON audit_log
  FOR INSERT TO CURRENT_USER
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- The operator tooling, likewise.
--
-- Retention purges, tenant offboarding and the encryption backfill all run on
-- the owner credential and all work ACROSS tenants by definition — "delete
-- every soft-deleted deal past its firm's window" is not a question that can be
-- asked from inside one tenant. Under a superuser owner they read everything
-- and nobody noticed they depended on that. Under `cre_owner` on RDS they set
-- no tenant context, tenant_isolation matches nothing, and every one of them
-- reports success over an empty set:
--
--     purge: 0 deals removed
--
-- which is indistinguishable from a clean system and would have been read as
-- one. A retention policy that quietly deletes nothing is a compliance claim
-- with nothing behind it.
--
-- These policies do NOT widen what the application can see. `app_user` — the
-- role every internet-facing request runs as — keeps tenant_isolation exactly
-- as it was, and that is the boundary the product is sold on. This admits the
-- OPERATOR's credential, which already owns these tables and can drop FORCE
-- from any of them at will. The gain is that the capability is now declared, in
-- pg_policies, where a reviewer can see it, instead of resting on whether
-- whoever provisioned the database happened to make the owner a superuser.
--
-- audit_log is excluded and keeps its two narrow policies above: SELECT for the
-- verifier, INSERT for the operator's own trail, and nothing for UPDATE or
-- DELETE.
DO $$
DECLARE t text;
BEGIN
  -- Every tenant-scoped table under row level security EXCEPT audit_log, which
  -- is handled narrowly above. tenant_keys is on this list deliberately: the
  -- crypto-shredding that offboarding depends on destroys a row here, and
  -- without access the offboarding reports keyDestroyed and destroys nothing —
  -- an erasure claim, made to a departing client firm, with a readable payload
  -- still sitting behind it.
  FOREACH t IN ARRAY ARRAY['users', 'deals', 'firm_defaults', 'sessions',
                           'tenant_keys', 'scim_tokens']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS owner_access ON %I', t);
    EXECUTE format($f$
      CREATE POLICY owner_access ON %I
        FOR ALL TO CURRENT_USER
        USING (true) WITH CHECK (true)
    $f$, t);
  END LOOP;
END $$;

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
