'use strict';

/**
 * The tenant boundary. If any test in this file fails, the product cannot be
 * sold to two firms at once, and nothing else in the codebase compensates.
 *
 * These run against a REAL Postgres, not a mock. Row level security is a
 * database behaviour with several documented ways to silently not apply — the
 * table owner bypasses it, a missing WITH CHECK lets writes cross a boundary
 * reads cannot, an unset session variable can mean "match everything" if the
 * predicate is written carelessly. A mock would happily confirm whatever the
 * implementation believes. Only the engine can be asked.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');

let env, seed, app;

test.before(async () => {
  env = await freshDatabase('isolation');
  seed = await seedTwoTenants(env.ownerUrl);
  app = new Client({ connectionString: env.appUrl });
  await app.connect();
});

test.after(async () => {
  if (app) await app.end();
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

test('a tenant sees only its own deals', async () => {
  const x = await asTenant(seed.a.tenantId, 'SELECT name FROM deals');
  const y = await asTenant(seed.b.tenantId, 'SELECT name FROM deals');
  assert.deepEqual(x.rows.map((r) => r.name), ['Firm X Tower']);
  assert.deepEqual(y.rows.map((r) => r.name), ['Firm Y Tower']);
});

test('naming another tenant\'s deal by its exact id returns nothing', async () => {
  // The realistic attack: an id leaks (a shared URL, a log line, a screenshot)
  // and is replayed by an authenticated user of a different firm. The query is
  // valid, the row exists, and the answer must still be empty.
  const r = await asTenant(seed.a.tenantId, 'SELECT * FROM deals WHERE id = $1', [seed.b.dealId]);
  assert.equal(r.rows.length, 0);
});

test('a query with NO tenant context sees nothing at all', async () => {
  // The forgotten-context case. It must fail CLOSED: a route that neglects to
  // establish a tenant returns an empty database, not every firm's pipeline.
  const r = await app.query('SELECT * FROM deals');
  assert.equal(r.rows.length, 0);
});

test('an empty or malformed tenant setting sees nothing', async () => {
  for (const bad of ['', 'not-a-uuid', "' OR '1'='1", '00000000-0000-0000-0000-000000000000']) {
    await app.query('BEGIN');
    await app.query('SELECT set_config($1,$2,true)', ['app.current_tenant', bad]);
    const r = await app.query('SELECT * FROM deals');
    await app.query('ROLLBACK');
    assert.equal(r.rows.length, 0, `tenant setting ${JSON.stringify(bad)} leaked rows`);
  }
});

test('a tenant cannot INSERT a row stamped with another tenant', async () => {
  // Planting rather than reading. A boundary that holds one way only is not a
  // boundary: a firm that can write into a competitor's pipeline can corrupt
  // it, or seed a deal that looks like the competitor's own work.
  //
  // NOT what makes this pass, though I first wrote that it was: Postgres falls
  // back to the USING expression as the WITH CHECK when WITH CHECK is omitted,
  // so deleting it from the policy changes nothing and this test still passes.
  // Verified by mutation. The explicit WITH CHECK in 001_tenancy.sql is
  // documentation and defence-in-depth against someone later narrowing USING
  // alone — it is not, by itself, load-bearing.
  await assert.rejects(
    () => asTenant(seed.a.tenantId,
      'INSERT INTO deals (tenant_id, name, payload) VALUES ($1,$2,$3)',
      [seed.b.tenantId, 'planted', JSON.stringify({})]),
    /row-level security/i,
  );
});

test('a tenant cannot UPDATE another tenant\'s deal', async () => {
  const r = await asTenant(seed.a.tenantId,
    'UPDATE deals SET name = $1 WHERE id = $2', ['hijacked', seed.b.dealId]);
  assert.equal(r.rowCount, 0);
  // And the row is untouched, which is the claim that actually matters.
  const check = await asTenant(seed.b.tenantId, 'SELECT name FROM deals WHERE id = $1', [seed.b.dealId]);
  assert.equal(check.rows[0].name, 'Firm Y Tower');
});

test('a tenant cannot UPDATE its own deal INTO another tenant', async () => {
  // The other direction: moving an existing row across the boundary rather than
  // writing a new one across it. Caught by the write-side check on the policy,
  // which — as above — is the USING expression when WITH CHECK is absent.
  await assert.rejects(
    () => asTenant(seed.a.tenantId,
      'UPDATE deals SET tenant_id = $1 WHERE id = $2', [seed.b.tenantId, seed.a.dealId]),
    /row-level security/i,
  );
});

test('a tenant cannot DELETE another tenant\'s deal', async () => {
  const r = await asTenant(seed.a.tenantId, 'DELETE FROM deals WHERE id = $1', [seed.b.dealId]);
  assert.equal(r.rowCount, 0);
});

test('users, firm defaults and the audit log are isolated too', async () => {
  // Deals are the obvious table. These are the ones that get forgotten — and a
  // leaked user list or audit trail is its own confidentiality incident.
  // `sessions` is deliberately absent: the tenant role cannot read it at all
  // now, which the next two tests assert directly.
  for (const table of ['users', 'firm_defaults', 'audit_log']) {
    const mine = await asTenant(seed.a.tenantId, `SELECT tenant_id FROM ${table}`);
    for (const row of mine.rows) {
      assert.equal(row.tenant_id, seed.a.tenantId, `${table} leaked a foreign tenant row`);
    }
  }
  const users = await asTenant(seed.a.tenantId, 'SELECT email FROM users');
  assert.deepEqual(users.rows.map((r) => r.email), ['analyst@firmx.com']);
});

test('the application role is not the table owner, and RLS is forced', async () => {
  // The two configuration facts every policy above depends on, asserted
  // directly — and this test is the ONLY thing that catches one of them.
  //
  // Mutation-verified. Pointing the app at the OWNER role fails 11 of the 12
  // tests in this file, so that regression is caught everywhere. Removing FORCE
  // ROW LEVEL SECURITY fails ONLY this test, because app_user is not the owner
  // and so is unaffected by it. FORCE is the guard for the day someone
  // reconfigures the app to connect as the owner; without this assertion that
  // guard could be deleted in silence and the loss would show up only once
  // that reconfiguration happened.
  const owner = new Client({ connectionString: env.ownerUrl });
  await owner.connect();
  try {
    const r = await owner.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('users','deals','firm_defaults','audit_log','sessions')
    `);
    assert.equal(r.rows.length, 5);
    for (const t of r.rows) {
      assert.equal(t.relrowsecurity, true, `${t.relname}: RLS not enabled`);
      assert.equal(t.relforcerowsecurity, true, `${t.relname}: RLS not FORCED`);
      assert.notEqual(t.owner, 'app_user', `${t.relname}: owned by the app role, which bypasses RLS`);
    }
  } finally {
    await owner.end();
  }
});

test('the audit log cannot be rewritten by the application', async () => {
  // Granted SELECT and INSERT only. An audit trail the app can edit is not
  // evidence of anything, and a compromised app would erase its own tracks.
  await asTenant(seed.a.tenantId,
    'INSERT INTO audit_log (tenant_id, action, actor_user_id) VALUES ($1,$2,$3)',
    [seed.a.tenantId, 'deal.viewed', seed.a.userId]);

  await assert.rejects(
    () => asTenant(seed.a.tenantId, "UPDATE audit_log SET action = 'nothing happened'"),
    /permission denied/i,
  );
  await assert.rejects(
    () => asTenant(seed.a.tenantId, 'DELETE FROM audit_log'),
    /permission denied/i,
  );
});

test('the app role cannot mutate the tenant registry through a request path', async () => {
  // Onboarding a tenant is a platform operation. If a request could write here
  // it could create a tenant, or move a broker org id onto one it controls, and
  // then be admitted to another firm's data by the login path.
  await assert.rejects(
    () => asTenant(seed.a.tenantId,
      "INSERT INTO tenants (slug, name) VALUES ('rogue','Rogue')"),
    /permission denied/i,
  );
  await assert.rejects(
    () => asTenant(seed.a.tenantId, "UPDATE tenants SET broker_org_id = 'org_y'"),
    /permission denied/i,
  );
});

test('the tenant-data role cannot touch the sessions table at all', async () => {
  // Privilege separation, asserted from the app_user side. Since migration 002
  // the tenant path has no grant and no policy on `sessions`, so a route on
  // that path cannot enumerate live sessions, cannot read a token hash, and
  // cannot mint one — not "does not", cannot. If this test starts passing a
  // SELECT, the split has been undone and a flaw in any tenant route becomes a
  // session-forgery flaw.
  for (const sql of [
    'SELECT * FROM sessions',
    'SELECT token_hash FROM sessions',
    "INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at) VALUES ('\\x00', $1, $2, now())",
    'UPDATE sessions SET revoked_at = NULL',
    'DELETE FROM sessions',
  ]) {
    await assert.rejects(
      () => asTenant(seed.a.tenantId, sql, sql.includes('$1') ? [seed.a.userId, seed.a.tenantId] : []),
      /permission denied/i,
      `app_user was permitted: ${sql}`,
    );
  }
});

test('the auth role can read sessions but cannot see a single deal', async () => {
  // The mirror image. A flaw in the authentication path must not become a data
  // breach: auth_user has no grant on deals or firm_defaults and no policy on
  // them, so the worst it can do is resolve identities.
  const auth = new Client({ connectionString: env.authUrl });
  await auth.connect();
  try {
    // Its own job works.
    await auth.query('SELECT id, tenant_id FROM sessions LIMIT 1');
    await auth.query('SELECT id FROM tenants LIMIT 1');
    // Everything else does not.
    for (const table of ['deals', 'firm_defaults', 'audit_log']) {
      await assert.rejects(
        () => auth.query(`SELECT * FROM ${table}`),
        /permission denied/i,
        `auth_user could read ${table}`,
      );
    }
    // It can read users — it needs the email and role to build a session — but
    // must not be able to change one, or it could grant itself admin.
    await auth.query('SELECT email, role FROM users LIMIT 1');
    await assert.rejects(
      () => auth.query("UPDATE users SET role = 'admin'"),
      /permission denied/i,
    );
    await assert.rejects(
      () => auth.query("INSERT INTO users (tenant_id, email) VALUES ($1,'x@y.z')", [seed.a.tenantId]),
      /permission denied/i,
    );
  } finally {
    await auth.end();
  }
});
