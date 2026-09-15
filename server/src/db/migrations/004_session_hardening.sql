-- ─── Session hardening ───────────────────────────────────────────────────────
--
-- IDLE TIMEOUT. Sessions carried an 8h absolute lifetime and nothing else, so a
-- deal screen left open on a shared workstation stayed authenticated all day.
-- Absolute and idle expiry answer different questions — "how long may a session
-- live" and "how long may it sit unused" — and a system needs both.
--
-- `last_seen_at` is updated at most once per SESSION_TOUCH_INTERVAL_MS rather
-- than on every request: a write per request turns every authenticated GET into
-- a database write and makes the sessions table the hottest in the system for
-- no security gain.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

-- AUTHENTICATION METHOD, as asserted by the identity provider. Delegating MFA
-- to the customer's directory is correct; being unable to PROVE it happened is
-- not. A security questionnaire asks "is MFA enforced" and the only honest
-- answer today is "we assume so". Recorded per session so the audit trail can
-- show how each person authenticated.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_method text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_asserted boolean;

CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions (last_seen_at)
  WHERE revoked_at IS NULL;

-- A tenant may require that the identity provider asserted multi-factor
-- authentication. NULL means "no policy" — not "off" — so an existing tenant is
-- not silently opted into a rule nobody chose for them.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS require_mfa boolean;
