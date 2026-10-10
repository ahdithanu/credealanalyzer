-- ─── SCIM provisioning, and the deprovisioning it exists for ────────────────
--
-- Disabling an analyst in Okta stops NEW logins. It does nothing to the session
-- they are already holding, which stays valid for up to the full session
-- lifetime. For someone leaving with a client firm's pipeline on screen, that
-- window IS the exposure, and "we disabled them in the directory" does not
-- close it. It is also the first thing an IT reviewer asks about.
--
-- So deprovisioning here is two writes that happen together or not at all: the
-- user is marked inactive, and every live session of theirs is revoked. A
-- deprovisioning that leaves a session alive is not a deprovisioning, and one
-- that half-applies is worse than one that fails.
--
-- ─── WHICH ROLE DOES IT, AND WHY IT IS THE AUTHENTICATION ONE ────────────────
--
-- Those two writes touch `users` and `sessions`, and since migration 002 no
-- role could touch both:
--
--   app_user   serves tenant data, writes `users`, and CANNOT SEE `sessions`
--              at all. Giving it sessions back to make this atomic would undo
--              the exact split 002 exists for: the tenant-data path would
--              regain the ability to mint and enumerate sessions.
--   auth_user  authenticates. Reads and writes `sessions`, and until now could
--              only READ `users`.
--
-- Two pools are two transactions, so one of the two roles had to grow by one
-- command. It is auth_user that gains UPDATE on `users`, because the privilege
-- it gains is one it already effectively has: auth_user can insert a session
-- row for any user in any tenant, so it can already admit anyone. The reverse —
-- handing `sessions` to app_user — would put that power in the role that serves
-- every tenant request, which is the one place it must never live.
--
-- The growth is one command and five columns, and everything else stays where
-- 002 put it. auth_user still cannot INSERT a user: creating a person is
-- ordinary provisioning, it happens on the tenant path under app_user, and a
-- user who does not exist yet has no session to revoke, so creation never
-- needed this transaction in the first place. The update is fenced three ways
-- below: it is tenant-scoped by policy rather than by a predicate in route
-- code, `role` is excluded from the column grant so a directory cannot promote
-- anyone, and the tenant comes from the token.

-- ─── Account lifecycle on users ─────────────────────────────────────────────
--
-- `active` is the state a directory drives. DEFAULT true and NOT NULL because
-- every user that exists today got here by authenticating, so "true" is a fact
-- about them rather than an assumption — unlike `deactivated_at`, which is NULL
-- for them because they have never been deactivated, and NULL is the only
-- honest value for a date that does not exist.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

-- The directory's OWN identifier for the person, kept separate from
-- `external_id` (the IdP subject claim seen at login) on purpose. Okta's SCIM
-- id and its SAML subject are often the same string and are not required to be;
-- one column holding either, depending on which system wrote last, is a column
-- that silently rebinds an account to a different person. Two columns, two
-- meanings.
ALTER TABLE users ADD COLUMN IF NOT EXISTS scim_external_id text;

-- Partial, so the many users with no SCIM identity do not collide with each
-- other, and so a directory cannot point two accounts at one of its users.
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_scim_external_idx
  ON users (tenant_id, scim_external_id) WHERE scim_external_id IS NOT NULL;

-- SCIM's meta.lastModified. Maintained by a TRIGGER rather than by each writer,
-- because a column only some writers remember to bump is a timestamp that
-- reports "unchanged" about a row that changed — and a directory told a record
-- is unchanged skips it.
--
-- NULLABLE, AND NOT BACKFILLED. Rows that existed before this migration have
-- been updated by the login path (`last_login_at`) without recording when, so
-- their last modification time is genuinely unknown. Stamping them with now(),
-- or with created_at, would publish a fabricated date through SCIM's
-- meta.lastModified. NULL says "we do not know", which is the truth, and every
-- row written from here on knows.
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz;

CREATE OR REPLACE FUNCTION users_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- INSERT as well as UPDATE: a row that has only ever been created was last
-- modified when it was created, and that is a fact rather than an inference.
DROP TRIGGER IF EXISTS users_touch_updated_at_trg ON users;
CREATE TRIGGER users_touch_updated_at_trg
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_touch_updated_at();

-- ─── SCIM bearer tokens ─────────────────────────────────────────────────────
--
-- A standing machine credential that can enumerate and deactivate every user in
-- a tenant. It is strictly more dangerous than a session: it does not expire on
-- idle, nobody is watching the browser it came from, and it is stored in a
-- third party's configuration screen.
--
-- Two halves, because they have different jobs:
--
--   token_id    PUBLIC. It is what the lookup below selects on, so no secret
--               value ever appears in a query, a query plan, pg_stat_statements
--               or a slow-query log.
--   token_hash  sha256 of the WHOLE presented token. The secret half is never
--               stored in any form that can be presented. A leaked dump of this
--               table — a backup, an over-broad support query — contains no
--               usable credential, exactly as `sessions` does not.
--
-- Comparison of the hash happens in constant time in the application; see
-- auth/provisioning.js.
CREATE TABLE IF NOT EXISTS scim_tokens (
  token_id     text PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL,
  -- Which directory this was issued to ("Okta production"), so revoking the
  -- right one during an incident does not require guessing.
  name         text NOT NULL,
  -- Who issued it, as the operator tooling recorded them. Free text: it comes
  -- from outside this system.
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- NULL means NO EXPIRY, which is a decision and not a default: the CLI
  -- refuses to issue a token unless the operator states one or the other. A
  -- standing credential that quietly never expires is how a token issued for a
  -- trial is still live three years later.
  expires_at   timestamptz,
  -- NULL means never used. Not "used at the epoch", and not zero.
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS scim_tokens_tenant_idx ON scim_tokens (tenant_id);

-- Default deny: RLS on and FORCED, so a role with no policy sees nothing.
ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_tokens FORCE ROW LEVEL SECURITY;

-- Resolving a token is what DISCOVERS the tenant, so it necessarily runs before
-- any tenant context exists — the same shape as session lookup in 002, and for
-- the same reason. What protects a row from auth_user itself is the token's own
-- entropy: the lookup is only ever by an id the caller already presented.
DROP POLICY IF EXISTS auth_scim_token_access ON scim_tokens;
CREATE POLICY auth_scim_token_access ON scim_tokens
  TO auth_user
  USING (true)
  WITH CHECK (true);

-- app_user is named nowhere here and gets no grant: the tenant-data path cannot
-- read a SCIM token any more than it can read a session.
GRANT SELECT ON scim_tokens TO auth_user;
-- Column-scoped on purpose. The authentication path stamps `last_used_at` and
-- nothing else — it cannot clear `revoked_at`, extend `expires_at` or repoint a
-- token at another tenant. Issuing and revoking are operator actions against
-- the owner credential, which the API never holds.
GRANT UPDATE (last_used_at) ON scim_tokens TO auth_user;

-- ─── A machine actor in the audit log ───────────────────────────────────────
--
-- The kinds in 003 were `user`, `operator` and `system`, all of which imply a
-- person or this software acting on its own. A directory deactivating an
-- account is neither, and recording it as `system` would put an outside party's
-- decisions under our own name in the one table an investigator trusts.
--
-- `scim` rather than a general `machine`: the next machine actor should have to
-- write a migration and say what it is, instead of inheriting a label that has
-- stopped meaning anything.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_kind_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_kind_check
  CHECK (actor_kind IN ('user', 'operator', 'system', 'scim'));

-- The SCIM path runs entirely on auth_user (see the note at the top), so that
-- role needs to append its own trail. Column-scoped exactly as app_user's grant
-- in 003 is, so the digest columns stay the trigger's to set, and INSERT only —
-- no UPDATE, no DELETE. The tenant_isolation policy from 001 is permissive and
-- role-agnostic, so it already binds these inserts to the tenant established
-- for the transaction; a platform-level row (tenant_id NULL) fails its WITH
-- CHECK, which is why a failed SCIM authentication is logged to stderr and not
-- to this table — we do not know whose tenant it was, and guessing is worse
-- than an unauthenticated caller being able to write rows here at all.
GRANT INSERT (tenant_id, actor_user_id, actor_kind, actor_ref,
              action, subject_type, subject_id, detail, ip) ON audit_log TO auth_user;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO auth_user;

-- ─── Tenant scoping for the authentication role ─────────────────────────────
--
-- auth_user's policies from 002 are USING (true) on `sessions` and on `users`,
-- and they have to be: resolving a cookie is what discovers the tenant, so it
-- runs with no tenant context. The SCIM path is the opposite case — it knows
-- its tenant before it touches a row — and under USING (true) a query there
-- that forgot its predicate would read every firm's users. That is precisely
-- the fail-open shape 001 was built to avoid, so the boundary is restored in
-- the database rather than written into route code.
--
-- AS RESTRICTIVE, so these AND with the existing policies instead of ORing with
-- them: a restrictive policy can only ever narrow, and one added later cannot
-- accidentally re-open what another closed.
--
-- The `current_tenant_id() IS NULL` arm is what keeps the login path working,
-- and it is a real weakening worth naming: a connection with no tenant set is
-- unrestricted, exactly as it is today. It narrows nothing that was narrow
-- before, and any path that DOES establish a tenant — every SCIM request — is
-- bound by it.
DROP POLICY IF EXISTS auth_user_tenant_scope ON users;
CREATE POLICY auth_user_tenant_scope ON users
  AS RESTRICTIVE
  TO auth_user
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id())
  WITH CHECK (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS auth_session_tenant_scope ON sessions;
CREATE POLICY auth_session_tenant_scope ON sessions
  AS RESTRICTIVE
  TO auth_user
  USING (current_tenant_id() IS NULL OR tenant_id = current_tenant_id())
  WITH CHECK (current_tenant_id() IS NULL OR tenant_id = current_tenant_id());

-- A session may not be MINTED for a deactivated user. Restrictive and INSERT
-- only, deliberately: revoking, expiring and touching an existing session must
-- keep working for a user who has just been deactivated — those are the writes
-- that shut them out, and a policy that blocked them would leave the session
-- alive.
--
-- This is the backstop for the case the whole feature is about: the directory
-- deprovisions, and something still tries to hand that person a session. The
-- login path does not read `active` yet, so the database refuses the row. The
-- visible result is a sign-in that fails rather than one that explains itself,
-- which is the right side of that trade.
DROP POLICY IF EXISTS auth_session_active_user ON sessions;
CREATE POLICY auth_session_active_user ON sessions
  AS RESTRICTIVE
  FOR INSERT
  TO auth_user
  WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id AND u.active));

-- ─── Updating users from the SCIM path ──────────────────────────────────────
--
-- ONE command, UPDATE, and the narrowness is the whole design. The
-- authentication role gets exactly the write that has to be atomic with
-- revoking a session, and nothing else:
--
--   No INSERT. Creating a person is ordinary provisioning and stays on the
--   tenant path under app_user, precisely as migration 002 said it should —
--   and a user who does not exist yet has no session to revoke, so creation
--   never needed this transaction. isolation.test.js asserts that the
--   authentication role cannot insert a user, and it still cannot.
--
--   No DELETE. SCIM's DELETE is served by deactivating instead, because
--   erasing a user erases the attribution on every deal they underwrote and
--   orphans every audit entry naming them: "who signed this off" stops having
--   an answer. A directory sync is not where that decision gets made.
DROP POLICY IF EXISTS scim_user_update ON users;
CREATE POLICY scim_user_update ON users
  FOR UPDATE
  TO auth_user
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- `role` is NOT in this column list, and its absence is the point: a directory
-- that can set it is a directory whose compromise mints an admin of a client
-- firm. Role changes stay with people who hold a session and the admin role.
-- `tenant_id` is absent for the same reason a tenant never comes from a
-- request: nothing on this path may move a person between firms.
GRANT UPDATE (email, name, scim_external_id, active, deactivated_at)
  ON users TO auth_user;
