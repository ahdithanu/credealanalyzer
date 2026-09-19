-- ─────────────────────────────────────────────────────────────────────────────
-- Duo as a second factor WE enforce.
--
-- WHY THIS EXISTS ALONGSIDE `tenants.require_mfa`, which already refuses a
-- login when the identity provider did not assert a second factor.
--
-- That check is a good control and it is entirely dependent on the customer's
-- directory telling the truth. It reads `amr`/`acr` out of the assertion: if a
-- firm's IdP is misconfigured, or simply does not populate those claims — which
-- is common — the claim is silent, `mfaAsserted` is NULL, and the tenant either
-- cannot enable the policy or is locked out by it. Either way the enforcement
-- point is somebody else's system, and "our customers' IdPs are configured
-- correctly" is not a control we can attest to in a security questionnaire.
--
-- This adds a factor at OUR door, for tenants that want one: after the identity
-- provider says who the person is, and before any session exists, the browser
-- is sent to that firm's own Duo tenant and has to come back with a signed
-- result. The two mechanisms compose rather than compete — a firm running Duo
-- SSO (Duo as the SAML IdP through the broker) leaves this disabled and is
-- not prompted twice.
--
-- THE INVARIANT EVERYTHING HERE PROTECTS: no session row is written until Duo
-- has returned a result that verifies. A design that issued a session and then
-- "required" a second factor at the screen would be a design where the second
-- factor is optional for anyone who does not load the screen.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─── Per-tenant Duo configuration ────────────────────────────────────────────
--
-- Per TENANT, not per platform, because a Duo integration belongs to the firm:
-- their account, their enrolled users, their policies, their bill. One shared
-- integration would mean every firm's users enrolled in our Duo account, which
-- is neither what they want nor something we could offboard cleanly.
CREATE TABLE IF NOT EXISTS tenant_duo (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  -- e.g. api-a1b2c3d4.duosecurity.com. Validated in the application against a
  -- strict pattern before any request is made: this value becomes the host of
  -- an outbound HTTPS call from inside our VPC, so an operator typo — or a
  -- compromised admin path — must not be able to point the token exchange at an
  -- arbitrary host and hand it a client assertion.
  api_host         text NOT NULL,

  -- Duo's client id is public in the same sense an OAuth client id is.
  client_id        text NOT NULL,

  -- The client secret is NOT stored in the clear.
  --
  -- It is sealed with the same AES-256-GCM envelope used for deal payloads
  -- (src/crypto/envelope.js), with the tenant id as additional authenticated
  -- data — so a ciphertext lifted from one row cannot be opened as another
  -- tenant's, even by someone holding the key.
  --
  -- The key is DUO_CONFIG_KEY, deliberately separate from both the per-tenant
  -- data keys and the session signing secret. Not the data keys, because those
  -- live behind tenant row level security on the app_user path and this row is
  -- read on the auth path, which must not reach across that boundary. Not the
  -- signing secret, because a key used to sign and a key used to encrypt should
  -- never be the same key: rotating one would silently mean rotating the other.
  client_secret_ct bytea NOT NULL,

  enabled          boolean NOT NULL DEFAULT false,

  -- What happens when Duo itself cannot be reached.
  --
  -- 'closed' is the default and the recommendation: if the second factor cannot
  -- be evaluated, the login does not happen. 'open' admits the user with the
  -- IdP's assertion alone, which is a real thing firms ask for — a Duo outage
  -- during an investment committee meeting is a churn event — and is also
  -- exactly how a second factor gets quietly bypassed. So it is per tenant,
  -- never the default, written to the audit log on every use, and alarmed on.
  fail_mode        text NOT NULL DEFAULT 'closed'
                   CHECK (fail_mode IN ('closed', 'open')),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Set by `npm run duo -- check`. A configuration that has never completed a
  -- health check against Duo is a configuration nobody has proven works, and
  -- the admin tooling reports the difference rather than showing a green flag
  -- for a row that was merely inserted.
  verified_at      timestamptz
);

-- Platform configuration, like `tenants` itself: not tenant-scoped data, and
-- never reachable through a tenant request path. The auth role reads it to run
-- a login; the tenant-data role has no grant on it at all.
GRANT SELECT ON tenant_duo TO auth_user;


-- ─── The pending challenge ───────────────────────────────────────────────────
--
-- The gap between "the identity provider said who you are" and "you have a
-- session". Everything the login needs to resume lives HERE, server-side, and
-- the browser carries nothing but an opaque single-use handle.
--
-- The alternative — a signed cookie carrying the user and tenant across the Duo
-- round trip — is the design to avoid. It moves the resolved identity into the
-- client, and every such scheme stands or falls on the signature being checked
-- perfectly every time. A row in a table cannot be forged by getting a
-- verification wrong.
CREATE TABLE IF NOT EXISTS mfa_pending (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Handed to the browser in a short-lived httpOnly cookie. Proves the callback
  -- arrives in the SAME browser that started the handshake.
  nonce_hash     bytea NOT NULL UNIQUE,

  -- Handed to Duo as the OIDC `state` and returned in the callback URL. Stored
  -- hashed for the same reason the session token is: this table is readable by
  -- anyone who can read the database, and a stored value that is also a live
  -- bearer credential is a credential sitting in a table.
  state_hash     bytea NOT NULL UNIQUE,

  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The username sent to Duo, kept so the callback can prove Duo's answer is
  -- about THIS person. See the note in src/auth/duo.js: without this check, an
  -- attacker who can complete Duo as themselves can bind their own successful
  -- second factor to a pending login for somebody else, and the whole factor
  -- becomes decorative.
  duo_username   text NOT NULL,

  redirect_to    text,
  ip             inet,
  user_agent     text,

  -- Carried across the round trip so the session that eventually gets issued
  -- records what the IdP said, not just what Duo said.
  auth_method    text,
  idp_mfa_asserted boolean,

  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Short. A second-factor prompt a person is looking at is answered in under a
  -- minute; five is generous and keeps a stolen callback URL useless quickly.
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS mfa_pending_expires_idx ON mfa_pending (expires_at);

-- Same treatment as `sessions`, for the same reason: looking a challenge up is
-- how the tenant is DISCOVERED, so it cannot be scoped by a tenant that is not
-- known yet. RLS on and forced, so the default is deny, and exactly one policy
-- granted to exactly one role.
ALTER TABLE mfa_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_pending FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_mfa_pending_access ON mfa_pending;
CREATE POLICY auth_mfa_pending_access ON mfa_pending
  TO auth_user
  USING (true)
  WITH CHECK (true);

-- The owner needs its own policy to run migrations, retention and diagnostics
-- against this table; FORCE subjects the owner to policies too. Mirrors what
-- migration 008 had to do for audit_log.
DROP POLICY IF EXISTS owner_access ON mfa_pending;
CREATE POLICY owner_access ON mfa_pending
  FOR ALL TO CURRENT_USER
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_pending TO auth_user;

-- app_user is named nowhere above and gets nothing here. The tenant-data role
-- cannot read a pending challenge, cannot create one, and therefore cannot be
-- talked into completing somebody's second factor from a request path.
REVOKE ALL ON mfa_pending FROM app_user;


-- ─── The session records which factor was actually used ──────────────────────
--
-- `mfa_asserted` already existed and means "the identity provider said a second
-- factor was used". That is a different claim from "we challenged them and Duo
-- returned a verified success", and collapsing the two would make the stronger
-- one unauditable. A firm asking "show me every session that went through Duo"
-- needs this column to answer.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_factor text
  CHECK (mfa_factor IS NULL OR mfa_factor IN ('duo', 'idp', 'duo_failopen'));

COMMENT ON COLUMN sessions.mfa_factor IS
  'duo = we challenged and Duo verified; idp = the provider asserted it and we did not '
  'challenge; duo_failopen = Duo was unreachable and the tenant admits on failure; '
  'NULL = no second factor is known to have been used.';
