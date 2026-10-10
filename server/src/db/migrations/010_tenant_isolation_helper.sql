-- ─────────────────────────────────────────────────────────────────────────────
-- One call to put a new tenant-scoped table under isolation.
--
-- WHY THIS EXISTS. Adding a tenant table today means remembering four separate
-- statements, and getting any one of them wrong fails in a different way:
--
--   ENABLE ROW LEVEL SECURITY   omitted → the table is readable across tenants
--                               and nothing anywhere complains.
--   FORCE ROW LEVEL SECURITY    omitted → the policies bind to app_user but not
--                               to the owner, so every test run over an owner
--                               connection passes and production is unprotected
--                               the moment anything runs as the owner.
--   WITH CHECK on the policy    omitted → reads are scoped but WRITES are not.
--                               A tenant can INSERT a row stamped with another
--                               tenant's id: writing across a boundary it
--                               cannot read across. Migration 001 calls this
--                               out and still spells it by hand each time.
--   owner_access                omitted → the SILENT one. FORCE subjects the
--                               owner to the policies too, so retention,
--                               diagnostics and later migrations match no rows
--                               and report success over an empty set. Migration
--                               008 found exactly this on audit_log: a purge
--                               that deleted nothing and read as a clean
--                               system.
--
-- Four statements, three of which fail quietly. That is a bad default for
-- something every new table needs, so it becomes one call that cannot forget a
-- half of itself.
--
-- WHY NOTHING IS RE-APPLIED RETROACTIVELY. It is tempting to run this over the
-- tables migrations 001–009 already cover and call them consistent. That would
-- be a regression, because their policy sets have diverged ON PURPOSE:
--
--   * `sessions` had tenant_isolation DROPPED in 002. Looking a session up is
--     how the tenant is DISCOVERED, so it cannot be scoped by a tenant that is
--     not known yet. Re-adding it would break login.
--   * `audit_log` is deliberately excluded from owner_access (008). It keeps
--     two narrow policies — SELECT for the verifier, INSERT for the operator's
--     trail — and nothing for UPDATE or DELETE. Granting the owner FOR ALL
--     would hand it the edit capability the hash chain exists to detect.
--
-- So this migration adds a tool and changes no existing table. The accompanying
-- test asserts that: if a future edit makes this function touch what is already
-- there, `sessions` regaining tenant_isolation and `audit_log` gaining
-- owner_access are both caught.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION apply_tenant_isolation(tbl regclass)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  coltype oid;
BEGIN
  -- `regclass` is the first guard and the reason this parameter is not text:
  -- a table that does not exist fails at the call site, and the value cannot
  -- carry an injected statement because Postgres has already resolved it to a
  -- catalog entry. Rendering it back with %s yields the schema-qualified,
  -- correctly-quoted name.

  SELECT atttypid INTO coltype
    FROM pg_attribute
   WHERE attrelid = tbl
     AND attname = 'tenant_id'
     AND attnum > 0
     AND NOT attisdropped;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'apply_tenant_isolation: % has no tenant_id column, so there is nothing '
      'to scope by. A table without one is not tenant data; either add the '
      'column or leave the table out of row level security deliberately, the '
      'way the platform tables are.', tbl;
  END IF;

  -- current_tenant_id() returns uuid. A text or bigint tenant_id would fail
  -- when CREATE POLICY parses the expression, but it fails as "operator does
  -- not exist: text = uuid" three frames from the cause.
  IF coltype <> 'uuid'::regtype THEN
    RAISE EXCEPTION
      'apply_tenant_isolation: %.tenant_id is %, not uuid. current_tenant_id() '
      'returns uuid and the policy comparison would have no operator.',
      tbl, format_type(coltype, NULL);
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  -- The line that makes the owner subject to its own policies too.
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);

  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  -- USING governs what can be READ (and which rows UPDATE/DELETE may touch).
  -- WITH CHECK governs what can be WRITTEN. Both, always, together.
  EXECUTE format($p$
    CREATE POLICY tenant_isolation ON %s
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id())
  $p$, tbl);

  -- Identical in shape to the owner_access policies written by hand in 008 and
  -- 009. TO CURRENT_USER binds it to whoever is applying the schema, which is
  -- the migration role — the same resolution the inline versions get.
  EXECUTE format('DROP POLICY IF EXISTS owner_access ON %s', tbl);
  EXECUTE format($p$
    CREATE POLICY owner_access ON %s
      FOR ALL TO CURRENT_USER
      USING (true) WITH CHECK (true)
  $p$, tbl);
END
$fn$;

-- SECURITY INVOKER (the default, stated by omission): the caller's own rights
-- apply, so this grants nobody the ability to alter a table they could not
-- already alter. The REVOKE is belt and braces — functions are executable by
-- PUBLIC unless told otherwise, and a schema-shaping helper reachable from the
-- request-path role is not something to leave lying around on a default.
REVOKE ALL ON FUNCTION apply_tenant_isolation(regclass) FROM PUBLIC;
