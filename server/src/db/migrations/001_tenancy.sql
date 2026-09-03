-- ─── Multi-tenancy, enforced by the database ────────────────────────────────
--
-- Every tenant-owned table carries `tenant_id` and has row level security ON
-- and FORCED. Isolation is therefore a property of the DATABASE, not of the
-- application: a route that forgets to add `WHERE tenant_id = ...` returns zero
-- rows instead of another firm's deals. That distinction is the whole reason
-- this is not done in application code — one forgotten predicate in one query
-- is a client-confidentiality incident, and no amount of code review reliably
-- catches every one of them forever.
--
-- Two things make it actually hold, and both are easy to get wrong:
--
--   1. The application connects as `app_user`, which does NOT own these tables.
--      A table's OWNER bypasses its own RLS policies silently. Migrations run
--      as the owner; requests never do.
--   2. FORCE ROW LEVEL SECURITY, so even the owner is subject to the policies.
--      Belt and braces: if someone later points the app at the owner role, the
--      boundary still holds instead of quietly evaporating.
--
-- The tenant for a request comes from `current_setting('app.current_tenant')`,
-- set with `set_config(..., true)` INSIDE a transaction so it is local to that
-- transaction and cannot leak to the next request that borrows the pooled
-- connection. See db/pool.js.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Roles ───────────────────────────────────────────────────────────────────
-- Created idempotently: migrations must be re-runnable.
-- `app_user` is the role the API connects as. It is LOGIN because the
-- application really does log in as it — but note what it is NOT: it does not
-- own these tables, and it is not a superuser. Both of those bypass row level
-- security, so the privilege separation below is the boundary, not the login
-- flag. In AWS this role holds no password of its own: it is granted `rds_iam`
-- and the task authenticates with a short-lived IAM token, so there is no
-- long-lived database credential in the image or in the environment.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN;
  END IF;
  -- Never let it accumulate privileges that would defeat the policies.
  -- Stated unconditionally rather than only at creation: roles are CLUSTER-wide,
  -- so an app_user left over from an earlier deploy with different flags would
  -- otherwise survive the IF NOT EXISTS guard above and keep them.
  EXECUTE 'ALTER ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
END $$;

-- ─── Tenant registry ─────────────────────────────────────────────────────────
-- NOT tenant-scoped: this is the platform's own table. It is readable only by
-- the platform, never through a tenant-scoped request path.
CREATE TABLE IF NOT EXISTS tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  -- The broker's organization id. This is the ONLY thing that may determine
  -- which tenant an authenticated user belongs to. A tenant id supplied by the
  -- client is never trusted for anything — see auth/session.js.
  broker_org_id   text UNIQUE,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Verified email domains. JIT provisioning admits a user to a tenant only if
-- their verified email domain is listed here. Without this, a misconfigured SSO
-- connection could place an outside address into a client firm's tenant.
CREATE TABLE IF NOT EXISTS tenant_domains (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain      text NOT NULL,
  verified_at timestamptz,
  PRIMARY KEY (tenant_id, domain)
);

-- ─── People ──────────────────────────────────────────────────────────────────
-- A person is scoped to one tenant. The same human at two client firms is two
-- rows, deliberately: merging them would create a cross-tenant join.
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL,
  name           text,
  -- Subject claim from the IdP, unique within the tenant's connection.
  external_id    text,
  role           text NOT NULL DEFAULT 'analyst'
                 CHECK (role IN ('analyst', 'vp', 'ic', 'admin')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- ─── Sessions ────────────────────────────────────────────────────────────────
-- Server-side so they can be REVOKED. A self-contained signed token cannot be
-- withdrawn before it expires, which is not acceptable when offboarding an
-- analyst who has seen a client's pipeline. Only a hash of the token is stored:
-- a dump of this table does not let the reader impersonate anyone.
CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- Single-use, short-lived SSO handshake state. Without this an attacker can
-- start a login and hand the victim the callback URL, logging them into an
-- account the attacker controls (login CSRF), or replay a captured callback.
CREATE TABLE IF NOT EXISTS sso_states (
  state         text PRIMARY KEY,
  tenant_hint   text,
  redirect_to   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);

-- ─── Deals ───────────────────────────────────────────────────────────────────
-- The underwriting payload stays JSONB: the engine in src/lib/finance.js is the
-- authority on its shape, it changes with underwriting policy, and pinning it
-- into columns here would make every policy change a migration. What IS
-- relational is everything the database has to enforce or index on.
CREATE TABLE IF NOT EXISTS deals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  stage         text,
  payload       jsonb NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS deals_tenant_idx ON deals (tenant_id) WHERE deleted_at IS NULL;

-- Firm assumption set, versioned. firmDefaults.js calls itself the governance
-- layer whose shape is right and whose persistence is not; this is the
-- persistence. Per tenant, because one firm's house standards are not another's.
CREATE TABLE IF NOT EXISTS firm_defaults (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version       text NOT NULL,
  assumptions   jsonb NOT NULL,
  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

-- ─── Audit ───────────────────────────────────────────────────────────────────
-- Append-only: no UPDATE or DELETE grant is issued to app_user below, so the
-- application cannot rewrite its own history even if compromised. An audit log
-- an attacker can edit is not an audit log.
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid,
  action        text NOT NULL,
  subject_type  text,
  subject_id    text,
  detail        jsonb,
  ip            inet,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_tenant_at_idx ON audit_log (tenant_id, at DESC);

-- ─── Row level security ──────────────────────────────────────────────────────
-- One helper so the predicate is written once. STABLE, not IMMUTABLE: it reads
-- a session setting, which changes between transactions.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('app.current_tenant', true);
  -- No tenant set means no tenant rows. Returning NULL makes every policy
  -- comparison NULL, which is not TRUE, so nothing is visible. A request that
  -- forgot to establish context therefore sees an empty database rather than
  -- everything.
  IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  -- A malformed setting is a bug or an injection attempt, never a tenant.
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'deals', 'firm_defaults', 'audit_log', 'sessions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- The line that makes the owner subject to its own policies too.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- USING governs what can be READ (and which rows UPDATE/DELETE may touch).
    -- WITH CHECK governs what can be WRITTEN: without it, a tenant could INSERT
    -- a row stamped with another tenant's id — writing across a boundary it
    -- cannot read across.
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $f$, t);
  END LOOP;
END $$;

-- ─── Grants ──────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, deals, firm_defaults, sessions TO app_user;
-- Append-only by grant, not by convention.
GRANT SELECT, INSERT ON audit_log TO app_user;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO app_user;
-- Platform tables: the app resolves a tenant by broker org id at login and
-- needs to read them, but must never mutate them through a request path.
GRANT SELECT ON tenants, tenant_domains TO app_user;
GRANT SELECT, INSERT, UPDATE ON sso_states TO app_user;
