-- ─────────────────────────────────────────────────────────────────────────────
-- A second way in: single-use email links, for firms with no identity provider.
--
-- Until now there is exactly one front door — WorkOS asserts an identity, Duo
-- may add a factor, a session is issued. That is the right default for a firm
-- with a directory and an impossible one for a firm without: there is no
-- password column anywhere in this schema, so a firm with no IdP cannot use
-- the product at all.
--
-- WHAT MAKES THIS SAFE IS WHERE THE TENANT COMES FROM, and it is worth being
-- explicit because the magic-link path has strictly less to work with than the
-- SSO path does.
--
--   SSO       the tenant is resolved from the BROKER's organization id, and the
--             verified email domain is a second, independent backstop. Two
--             facts have to agree.
--   magic link there is no assertion. The verified email domain is the ONLY
--             binding between an address and a firm.
--
-- So the domain check stops being a backstop and becomes the whole control,
-- and everything below exists to keep that one control honest.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Which methods a firm may use ────────────────────────────────────────────
-- Defaulted to SSO alone, and existing rows take that default. A firm that
-- bought a product where the only way in is their own directory does not get a
-- weaker one added by a migration; enabling magic links is a deliberate act per
-- tenant. The same reasoning as `require_mfa` being NULL rather than false.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS auth_methods text[] NOT NULL DEFAULT ARRAY['sso'];

DO $$ BEGIN
  -- An unknown string here would be read as "method not allowed" by the
  -- application and as "configured" by whoever typed it. Constrain the
  -- vocabulary so a typo fails at the write.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_auth_methods_known') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_auth_methods_known
      CHECK (auth_methods <@ ARRAY['sso', 'magic_link']);
  END IF;
  -- An empty array is a tenant nobody can sign in to. That is what `status`
  -- is for, and a suspension expressed two ways is a suspension that can be
  -- lifted in one place and not the other.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_auth_methods_nonempty') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_auth_methods_nonempty
      CHECK (array_length(auth_methods, 1) >= 1);
  END IF;
END $$;

-- ─── One verified domain, one firm ───────────────────────────────────────────
-- tenant_domains is keyed (tenant_id, domain), so nothing has ever stopped two
-- tenants verifying the same domain. Under SSO that is survivable: the tenant
-- comes from the organization id and the domain only has to agree with it.
-- Under a magic link it is not survivable at all — the domain IS the tenant
-- lookup, and a domain matching two firms means the link admits its holder to
-- whichever row the planner returned first. That is a cross-tenant admission
-- with no attacker required.
--
-- The application refuses an ambiguous domain at runtime regardless (see
-- auth/magicLink.js); this index is what makes that refusal unreachable rather
-- than load-bearing. Checked first and raised with the offenders named, so a
-- cluster that already holds a duplicate says which one instead of failing on
-- an opaque index violation.
DO $$
DECLARE dupes text;
BEGIN
  SELECT string_agg(d, ', ') INTO dupes FROM (
    SELECT lower(domain) AS d
      FROM tenant_domains
     WHERE verified_at IS NOT NULL
     GROUP BY lower(domain)
    HAVING count(DISTINCT tenant_id) > 1
  ) q;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'These domains are verified for more than one tenant: %. A verified '
      'domain is the only thing binding an email address to a firm on the '
      'magic-link path, so it cannot be ambiguous. Un-verify the duplicates '
      'before applying this migration.', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_verified_unique
  ON tenant_domains (lower(domain)) WHERE verified_at IS NOT NULL;

-- ─── The links ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Only the hash, for the reason sessions and mfa_pending store only a hash:
  -- the raw value is a live bearer credential, and a credential sitting in a
  -- table is a credential in every backup and every support query.
  token_hash    bytea NOT NULL UNIQUE,

  -- Resolved when the link is ISSUED, from the verified domain, and then
  -- frozen. Re-resolving at consume time would mean a link's destination could
  -- change under it — a domain re-verified to another firm between send and
  -- click would redirect an in-flight link into that firm.
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- The address the link was SENT to. The login provisions this address and no
  -- other. Without it the holder of a link could present any address they
  -- liked at consume time, and the link would stop being proof of anything
  -- except that someone clicked it.
  email         text NOT NULL,

  redirect_to   text,
  ip            inet,
  user_agent    text,

  expires_at    timestamptz NOT NULL,
  -- Single use. Set in the same UPDATE that claims the row, so two concurrent
  -- clicks cannot both win — see auth/magicLink.js.
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Consumption looks a link up by token hash alone, so this index is the whole
-- hot path. The expiry index is for the sweeper.
CREATE INDEX IF NOT EXISTS login_links_expires_idx ON login_links (expires_at);
-- Rate limiting and abuse review ask "how many links for this address lately",
-- which is a different access pattern from consuming one.
CREATE INDEX IF NOT EXISTS login_links_email_idx ON login_links (lower(email), created_at DESC);

-- Same treatment as `sessions` and `mfa_pending`, for the same reason, and
-- DELIBERATELY NOT apply_tenant_isolation() from migration 010: looking a link
-- up is how the tenant is DISCOVERED, so the row cannot be scoped by a tenant
-- that is not known yet. A tenant_isolation policy here would match no rows
-- and every magic-link login would fail closed.
ALTER TABLE login_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_login_link_access ON login_links;
CREATE POLICY auth_login_link_access ON login_links
  TO auth_user
  USING (true)
  WITH CHECK (true);

-- The owner needs its own policy to run migrations, retention and diagnostics
-- against this table; FORCE subjects the owner to policies too. Mirrors what
-- migrations 008 and 009 had to do.
DROP POLICY IF EXISTS owner_access ON login_links;
CREATE POLICY owner_access ON login_links
  FOR ALL TO CURRENT_USER
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON login_links TO auth_user;

-- app_user is named nowhere above and gets nothing here. The tenant-data role
-- cannot read a pending link, cannot create one, and therefore cannot be
-- talked into minting a login from a request path.
REVOKE ALL ON login_links FROM app_user;
