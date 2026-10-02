'use strict';

/**
 * apply_tenant_isolation(regclass) — migration 010.
 *
 * The helper exists so a new tenant table cannot be added with three of its
 * four protections missing. These tests check the two halves of that claim:
 * that a table it is applied to is genuinely isolated (not merely decorated
 * with policies that read correctly in pg_policies), and that applying it
 * changed nothing about the tables whose policy sets diverged on purpose.
 *
 * Against a real Postgres, for the reason isolation.test.js gives: every
 * documented way for row level security to silently not apply is an engine
 * behaviour, and a mock would confirm whatever the implementation believes.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');

let env, seed, owner, app;

test.before(async () => {
  env = await freshDatabase('tenantiso');
  seed = await seedTwoTenants(env.ownerUrl);

  // The MIGRATION role, not the superuser: a table created here is owned by
  // cre_owner exactly as a migrated one is, so FORCE and owner_access mean
  // what they will mean in AWS. Created over the superuser connection instead,
  // the owner would bypass RLS unconditionally and every assertion below would
  // pass without proving anything.
  owner = new Client({ connectionString: env.migrationUrl });
  await owner.connect();

  await owner.query(`CREATE TABLE documents (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title     text NOT NULL
  )`);
  await owner.query('SELECT apply_tenant_isolation($1)', ['documents']);
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO app_user');

  await owner.query(
    'INSERT INTO documents (tenant_id, title) VALUES ($1,$2), ($3,$4)',
    [seed.a.tenantId, 'Firm X offering memo', seed.b.tenantId, 'Firm Y offering memo'],
  );

  app = new Client({ connectionString: env.appUrl });
  await app.connect();
});

test.after(async () => {
  if (app) await app.end();
  if (owner) await owner.end();
  if (env) await env.drop();
});

/** Run a statement with a tenant context, exactly as withTenant() does. */
async function asTenant(tenantId, sql, params = []) {
  await app.query('BEGIN');
  try {
    await app.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);
    const r = await app.query(sql, params);
    await app.query('COMMIT');
    return r;
  } catch (e) {
    await app.query('ROLLBACK');
    throw e;
  }
}

// ─── The table it was applied to is actually isolated ────────────────────────

test('a table it was applied to shows each tenant only its own rows', async () => {
  const x = await asTenant(seed.a.tenantId, 'SELECT title FROM documents');
  assert.deepStrictEqual(x.rows.map((r) => r.title), ['Firm X offering memo']);

  const y = await asTenant(seed.b.tenantId, 'SELECT title FROM documents');
  assert.deepStrictEqual(y.rows.map((r) => r.title), ['Firm Y offering memo']);
});

test('with no tenant context it shows nothing at all', async () => {
  const r = await app.query('SELECT title FROM documents');
  assert.deepStrictEqual(r.rows, []);
});

test('WITH CHECK is present: a tenant cannot insert a row stamped for another', async () => {
  // The failure this guards is writing across a boundary that cannot be read
  // across, which a USING-only policy permits.
  await assert.rejects(
    () => asTenant(seed.a.tenantId,
      'INSERT INTO documents (tenant_id, title) VALUES ($1,$2)',
      [seed.b.tenantId, 'planted']),
    /row-level security/i,
  );
  const r = await owner.query('SELECT count(*)::int AS n FROM documents WHERE title = $1', ['planted']);
  assert.strictEqual(r.rows[0].n, 0);
});

test('WITH CHECK is present on UPDATE too: a row cannot be moved to another tenant', async () => {
  await assert.rejects(
    () => asTenant(seed.a.tenantId,
      'UPDATE documents SET tenant_id = $1 WHERE title = $2',
      [seed.b.tenantId, 'Firm X offering memo']),
    /row-level security/i,
  );
});

test('WITH CHECK is written explicitly, not left to Postgres to infer', async () => {
  // Behaviourally this is belt and braces: with WITH CHECK omitted, Postgres
  // uses the USING expression for write checks too, so the previous two tests
  // pass either way and removing the clause is an EQUIVALENT MUTANT. It is
  // asserted anyway because the clause is load-bearing the moment the two
  // expressions differ, and the point of this helper is that a new table
  // cannot be added with a half of its protection missing. This pins the
  // intent; the two tests above pin the behaviour.
  const r = await owner.query(
    `SELECT pg_get_expr(polwithcheck, polrelid) AS wc
       FROM pg_policy
      WHERE polrelid = 'documents'::regclass AND polname = 'tenant_isolation'`,
  );
  assert.match(r.rows[0].wc || '', /tenant_id = current_tenant_id\(\)/);
});

test('FORCE is set, so the owner is subject to the policies too', async () => {
  const r = await owner.query(
    `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class WHERE oid = 'documents'::regclass`,
  );
  assert.strictEqual(r.rows[0].relrowsecurity, true, 'ENABLE ROW LEVEL SECURITY');
  assert.strictEqual(r.rows[0].relforcerowsecurity, true, 'FORCE ROW LEVEL SECURITY');
});

test('the owner can still reach every row, via owner_access rather than by bypassing', async () => {
  // Without this policy FORCE would leave retention and later migrations
  // matching no rows and reporting success over an empty set — the silent
  // failure migration 008 found on audit_log.
  const r = await owner.query('SELECT count(*)::int AS n FROM documents');
  assert.strictEqual(r.rows[0].n, 2);

  const p = await owner.query(
    `SELECT polname FROM pg_policy WHERE polrelid = 'documents'::regclass ORDER BY polname`,
  );
  assert.deepStrictEqual(p.rows.map((r) => r.polname), ['owner_access', 'tenant_isolation']);
});

// ─── It refuses what it cannot scope ─────────────────────────────────────────

test('it refuses a table with no tenant_id, naming the table', async () => {
  await owner.query('CREATE TABLE no_tenant (id uuid PRIMARY KEY, note text)');
  await assert.rejects(
    () => owner.query('SELECT apply_tenant_isolation($1)', ['no_tenant']),
    /has no tenant_id column/,
  );
  // And it left the table alone rather than half-applying.
  const r = await owner.query(
    `SELECT relrowsecurity FROM pg_class WHERE oid = 'no_tenant'::regclass`,
  );
  assert.strictEqual(r.rows[0].relrowsecurity, false);
});

test('it refuses a tenant_id that is not uuid, rather than failing on the operator', async () => {
  await owner.query('CREATE TABLE text_tenant (id uuid PRIMARY KEY, tenant_id text NOT NULL)');
  await assert.rejects(
    () => owner.query('SELECT apply_tenant_isolation($1)', ['text_tenant']),
    /tenant_id is text, not uuid/,
  );
});

test('it refuses a table that does not exist, at the call site', async () => {
  await assert.rejects(
    () => owner.query('SELECT apply_tenant_isolation($1)', ['no_such_table']),
    /does not exist/,
  );
});

test('it is not executable by the request-path role', async () => {
  await assert.rejects(
    () => app.query('SELECT apply_tenant_isolation($1)', ['documents']),
    /permission denied for function apply_tenant_isolation/,
  );
});

// ─── It changed nothing that was already there ───────────────────────────────

test('sessions did NOT regain tenant_isolation', async () => {
  // Migration 002 dropped it deliberately: looking a session up is how the
  // tenant is discovered, so it cannot be scoped by a tenant not yet known.
  // Re-applying the helper across existing tables would break login.
  const r = await owner.query(
    `SELECT polname FROM pg_policy WHERE polrelid = 'sessions'::regclass AND polname = 'tenant_isolation'`,
  );
  assert.deepStrictEqual(r.rows, [], 'sessions must not carry tenant_isolation');
});

test('audit_log did NOT gain owner_access', async () => {
  // 008 excludes it on purpose: FOR ALL to the owner would hand it the UPDATE
  // and DELETE capability the hash chain exists to make detectable.
  const r = await owner.query(
    `SELECT polname FROM pg_policy WHERE polrelid = 'audit_log'::regclass AND polname = 'owner_access'`,
  );
  assert.deepStrictEqual(r.rows, [], 'audit_log must not carry owner_access');
});

test('the policy set of every pre-existing table is unchanged by migration 010', async () => {
  // A snapshot, so that a future edit making the helper touch existing tables
  // fails here with the table named rather than somewhere in production.
  const r = await owner.query(`
    SELECT c.relname AS tbl, p.polname
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname <> 'documents'
     ORDER BY c.relname, p.polname`);
  const actual = r.rows.map((x) => `${x.tbl}.${x.polname}`);
  assert.deepStrictEqual(actual, [
    'audit_log.audit_log_owner_read',
    'audit_log.audit_log_owner_write',
    'audit_log.tenant_isolation',
    'deals.owner_access',
    'deals.tenant_isolation',
    'firm_defaults.owner_access',
    'firm_defaults.tenant_isolation',
    'mfa_pending.auth_mfa_pending_access',
    'mfa_pending.owner_access',
    'scim_tokens.auth_scim_token_access',
    'scim_tokens.owner_access',
    'sessions.auth_session_access',
    'sessions.auth_session_active_user',
    'sessions.auth_session_tenant_scope',
    'sessions.owner_access',
    'tenant_keys.owner_access',
    'tenant_keys.tenant_isolation',
    'users.auth_user_read',
    'users.auth_user_tenant_scope',
    'users.owner_access',
    'users.scim_user_update',
    'users.tenant_isolation',
  ]);
});
