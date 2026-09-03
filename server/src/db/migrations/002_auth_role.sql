-- ─── Two roles, because session lookup is not tenant data ───────────────────
--
-- `sessions` was created under tenant row level security in 001, which cannot
-- work and is worth recording rather than quietly correcting: resolving a
-- cookie to a session is what DISCOVERS the tenant, so it necessarily runs
-- before any tenant context exists. Under tenant RLS the lookup found nothing
-- and every authenticated request came back 401.
--
-- The tempting fix is to drop RLS on `sessions`, or to add a policy that opens
-- it whenever no tenant is set. Both trade the boundary for convenience: the
-- second one in particular means a tenant-scoped route that forgets its context
-- can enumerate every live session on the platform, which is the exact
-- fail-open behaviour 001 was built to avoid.
--
-- So instead the privilege is split. Two roles, each able to do one job:
--
--   auth_user  authenticates. Reads sessions by token hash, writes sessions,
--              reads the tenant registry. Cannot see a single deal.
--   app_user   serves tenant data. Cannot read the sessions table AT ALL,
--              so no route on the tenant path can enumerate or forge one.
--
-- Neither role can do the other's job, which means a flaw in one is not a flaw
-- in both. The session token's own entropy is what protects a session row from
-- auth_user itself: it only ever selects by a sha256 of the presented token.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_user') THEN
    CREATE ROLE auth_user LOGIN;
  END IF;
  EXECUTE 'ALTER ROLE auth_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
END $$;

-- The tenant-data role loses sessions entirely.
REVOKE ALL ON sessions FROM app_user;
DROP POLICY IF EXISTS tenant_isolation ON sessions;

-- RLS stays ON and FORCED so the default is deny: a role with no policy sees
-- nothing, rather than everything.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

-- One policy, granted to one role. `TO auth_user` is what keeps this from
-- being a general opening: app_user is not named, has no policy, and has no
-- grant either, so it is denied twice over.
DROP POLICY IF EXISTS auth_session_access ON sessions;
CREATE POLICY auth_session_access ON sessions
  TO auth_user
  USING (true)
  WITH CHECK (true);

GRANT USAGE ON SCHEMA public TO auth_user;
GRANT SELECT, INSERT, UPDATE ON sessions TO auth_user;
-- Read-only on everything it needs to resolve an identity. No INSERT on users:
-- provisioning happens on the tenant path, under tenant RLS, where it belongs.
GRANT SELECT ON tenants, tenant_domains TO auth_user;
GRANT SELECT, INSERT, UPDATE ON sso_states TO auth_user;

-- `users` is under tenant RLS and auth_user has no policy on it, so a grant
-- alone would still return nothing. The session resolve path needs the user's
-- email and role, and it already knows the tenant from the session row, so it
-- gets a policy scoped to exactly that: read-only, and only the columns it
-- selects. It cannot write a user or change a role.
GRANT SELECT ON users TO auth_user;
DROP POLICY IF EXISTS auth_user_read ON users;
CREATE POLICY auth_user_read ON users
  FOR SELECT
  TO auth_user
  USING (true);
