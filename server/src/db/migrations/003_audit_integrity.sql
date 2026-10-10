-- ─── Audit: actor identity, admin actions, and tamper evidence ───────────────
--
-- Three gaps closed together because they are one table.
--
-- 1. ADMIN ACTIONS WERE NOT AUDITED AT ALL. Creating a tenant, verifying a
--    domain and suspending access are the highest-privilege operations in the
--    system — domain verification is literally what admits a person to a firm's
--    data — and none of them wrote a row. After an incident there was no way to
--    answer "who granted that, and when".
--
--    They could not be audited as the schema stood: `audit_log.tenant_id` is
--    NOT NULL and references `tenants`, so "a tenant was created" had nowhere to
--    live, and `actor_user_id` assumes an end user when the actor is an
--    operator holding the owner credential. Hence `actor_kind` and `actor_ref`.
--
-- 2. NO TAMPER EVIDENCE. Append-only by GRANT stops the application; it does
--    not stop anyone holding the owner credential, which is exactly the threat
--    an audit log exists to address. A hash chain does not prevent an edit — it
--    makes an edit detectable, which is the honest property to claim.
--
-- 3. NO READ PATH. Customers could not see their own trail. The policy below
--    lets a tenant read its own entries; the route is in routes/audit.js.

-- The actor is not always an end user.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_kind text
  NOT NULL DEFAULT 'user'
  CHECK (actor_kind IN ('user', 'operator', 'system'));
-- For an operator: who, as recorded by the tooling (an OS user, an SSO subject,
-- a break-glass identity). Free text because it comes from outside this system.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_ref text;

-- Platform-level events — tenant created, tenant suspended — belong to no
-- tenant. Made nullable so they can be recorded at all.
ALTER TABLE audit_log ALTER COLUMN tenant_id DROP NOT NULL;

-- ─── Hash chain ──────────────────────────────────────────────────────────────
-- Each row commits to its own content AND to the previous row's digest, so
-- altering or deleting any historical row breaks every digest after it.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash bytea;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash bytea;

/**
 * Compute and attach the digest, in a trigger rather than in application code.
 *
 * In the application, an attacker who reaches the API can write rows with any
 * digest they like and the chain verifies. In a trigger owned by a role the
 * application does not hold, the digest is computed by the database on every
 * insert, and `app_user` cannot change the function. That is the difference
 * between tamper evidence and decoration.
 */
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  prev bytea;
BEGIN
  -- The chain is GLOBAL, not per tenant. A per-tenant chain lets an operator
  -- delete one tenant's entire history and leave a self-consistent chain
  -- behind; a global one makes any deletion visible from the next row on.
  SELECT entry_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;

  -- Every field a reader would rely on goes into the digest. A field left out
  -- is a field that can be edited without detection — so if a column is added
  -- later, it belongs here too.
  NEW.entry_hash := digest(
    coalesce(encode(prev, 'hex'), '')
      || '|' || coalesce(NEW.tenant_id::text, '')
      || '|' || coalesce(NEW.actor_user_id::text, '')
      || '|' || NEW.actor_kind
      || '|' || coalesce(NEW.actor_ref, '')
      || '|' || NEW.action
      || '|' || coalesce(NEW.subject_type, '')
      || '|' || coalesce(NEW.subject_id, '')
      || '|' || coalesce(NEW.detail::text, '')
      || '|' || coalesce(NEW.ip::text, '')
      || '|' || NEW.at::text,
    'sha256');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_log_chain_trg ON audit_log;
CREATE TRIGGER audit_log_chain_trg
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- The application must not be able to set a digest itself.
REVOKE INSERT ON audit_log FROM app_user;
GRANT INSERT (tenant_id, actor_user_id, actor_kind, actor_ref,
              action, subject_type, subject_id, detail, ip) ON audit_log TO app_user;

-- ─── Read path ───────────────────────────────────────────────────────────────
-- The tenant_isolation policy from 001 already scopes SELECT to the current
-- tenant. Platform rows (tenant_id NULL) are deliberately NOT visible to any
-- tenant: "a different firm was suspended" is not their business.

-- ─── Backfill ────────────────────────────────────────────────────────────────
--
-- Rows written BEFORE this migration have no digest, and without this the chain
-- reports itself broken forever — which a restore drill found immediately, and
-- which would have read as evidence of tampering on a healthy system. An
-- integrity check that cries wolf on day one is an integrity check nobody
-- consults on day ninety.
--
-- WHAT THIS DOES AND DOES NOT PROVE, stated because the distinction is the whole
-- value of the chain: a digest computed now over a historical row proves nothing
-- about whether that row was altered BEFORE this migration ran. It establishes a
-- baseline. Tampering after this point is detectable; tampering before it is
-- not, and no amount of hashing afterwards can change that.
DO $$
DECLARE
  r record;
  running bytea;
BEGIN
  SELECT entry_hash INTO running FROM audit_log
   WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1;

  FOR r IN SELECT * FROM audit_log WHERE entry_hash IS NULL ORDER BY id LOOP
    running := digest(
      coalesce(encode(running, 'hex'), '')
        || '|' || coalesce(r.tenant_id::text, '')
        || '|' || coalesce(r.actor_user_id::text, '')
        || '|' || coalesce(r.actor_kind, 'user')
        || '|' || coalesce(r.actor_ref, '')
        || '|' || r.action
        || '|' || coalesce(r.subject_type, '')
        || '|' || coalesce(r.subject_id, '')
        || '|' || coalesce(r.detail::text, '')
        || '|' || coalesce(r.ip::text, '')
        || '|' || r.at::text,
      'sha256');
    UPDATE audit_log
       SET prev_hash = (SELECT entry_hash FROM audit_log p
                         WHERE p.id < r.id ORDER BY p.id DESC LIMIT 1),
           entry_hash = running
     WHERE id = r.id;
  END LOOP;
END $$;

-- ─── Verification helper ─────────────────────────────────────────────────────
/**
 * Recompute the chain and return the first row where it breaks.
 *
 * Returns zero rows when the log is intact. Deliberately a function rather than
 * a stored flag: a flag can be set, a recomputation cannot be faked without the
 * ability to recompute every subsequent digest.
 */
CREATE OR REPLACE FUNCTION audit_log_verify(from_id bigint DEFAULT 0)
RETURNS TABLE (broken_at bigint, reason text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log%ROWTYPE;
  expected bytea;
  running bytea;
  first boolean := true;
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE id > from_id ORDER BY id LOOP
    -- An un-chained row after the backfill means someone inserted around the
    -- trigger. Named distinctly, because "no digest" and "wrong digest" are
    -- different events and collapsing them loses the more alarming one.
    IF r.entry_hash IS NULL THEN
      broken_at := r.id;
      reason := 'entry has no digest — inserted without the chain trigger';
      RETURN NEXT;
      RETURN;
    END IF;

    IF first THEN
      running := r.prev_hash;   -- trust the starting point; verify onward
      first := false;
    ELSIF r.prev_hash IS DISTINCT FROM running THEN
      broken_at := r.id;
      reason := 'prev_hash does not match the preceding entry';
      RETURN NEXT;
      RETURN;
    END IF;

    expected := digest(
      coalesce(encode(r.prev_hash, 'hex'), '')
        || '|' || coalesce(r.tenant_id::text, '')
        || '|' || coalesce(r.actor_user_id::text, '')
        || '|' || r.actor_kind
        || '|' || coalesce(r.actor_ref, '')
        || '|' || r.action
        || '|' || coalesce(r.subject_type, '')
        || '|' || coalesce(r.subject_id, '')
        || '|' || coalesce(r.detail::text, '')
        || '|' || coalesce(r.ip::text, '')
        || '|' || r.at::text,
      'sha256');

    IF expected IS DISTINCT FROM r.entry_hash THEN
      broken_at := r.id;
      reason := 'entry contents do not match its digest';
      RETURN NEXT;
      RETURN;
    END IF;
    running := r.entry_hash;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION audit_log_verify(bigint) TO app_user;
