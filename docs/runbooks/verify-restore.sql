-- Run against a RESTORED database before cutting over to it.
--
-- A restore that comes back missing its roles, or with roles carrying different
-- attributes, looks completely healthy: the application connects, queries
-- succeed, and there is no tenant boundary. This refuses rather than warns,
-- because a warning during an outage is a warning nobody reads.
\set ON_ERROR_STOP on

DO $$
DECLARE
  n int;
BEGIN
  -- 1. Both application roles exist.
  SELECT count(*) INTO n FROM pg_roles WHERE rolname IN ('app_user', 'auth_user');
  IF n <> 2 THEN
    RAISE EXCEPTION 'RESTORE INVALID: expected app_user and auth_user, found % of 2', n;
  END IF;

  -- 2. Neither may bypass row level security. This is the silent killer: the app
  --    connects, everything works, and every tenant sees every other tenant.
  SELECT count(*) INTO n FROM pg_roles
   WHERE rolname IN ('app_user', 'auth_user')
     AND (rolbypassrls OR rolsuper);
  IF n > 0 THEN
    RAISE EXCEPTION 'RESTORE INVALID: an application role can bypass row level security';
  END IF;

  -- 3. RLS is enabled AND forced on every tenant-scoped table.
  SELECT count(*) INTO n FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relname IN ('users', 'deals', 'firm_defaults', 'audit_log', 'sessions')
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 5 THEN
    RAISE EXCEPTION 'RESTORE INVALID: only % of 5 tables have RLS enabled and forced', n;
  END IF;

  -- 4. The application role does not OWN the tables. An owner is exempt from its
  --    own policies, so this alone would remove the boundary.
  SELECT count(*) INTO n FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relname IN ('users', 'deals', 'firm_defaults', 'audit_log', 'sessions')
     AND pg_get_userbyid(c.relowner) IN ('app_user', 'auth_user');
  IF n > 0 THEN
    RAISE EXCEPTION 'RESTORE INVALID: an application role owns % tenant table(s)', n;
  END IF;

  -- 5. app_user still cannot read sessions. The privilege split from migration
  --    002 is what keeps an API flaw from becoming session forgery.
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'app_user' AND table_name = 'sessions';
  IF n > 0 THEN
    RAISE EXCEPTION 'RESTORE INVALID: app_user has % grant(s) on sessions', n;
  END IF;

  -- 6. The audit chain verifies. A restore that brings back a broken chain means
  --    the damage predates the restore point.
  --
  --    Checked for existence first. A restore to a point BEFORE migration 003 is
  --    a legitimate thing to do in an emergency, and it should say so plainly
  --    rather than dying on "function does not exist" — which is what happened
  --    the first time this was drilled, and reads like the script is broken
  --    rather than like the restore predates the audit chain.
  IF to_regprocedure('audit_log_verify(bigint)') IS NULL THEN
    RAISE EXCEPTION 'RESTORE INVALID: audit_log_verify() is absent, so this restore '
      'predates migration 003. Apply migrations before cutting over, and treat the '
      'audit trail as unverifiable for the period before the restore point.';
  END IF;

  SELECT count(*) INTO n FROM audit_log_verify();
  IF n > 0 THEN
    RAISE EXCEPTION 'RESTORE INVALID: the audit chain does not verify';
  END IF;

  RAISE NOTICE 'Restore verified: roles, RLS, ownership, privilege split and audit chain all intact.';
END $$;
