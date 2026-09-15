'use strict';

/**
 * The audit trail: coverage, integrity, and who can read it.
 *
 * An audit log is only worth what it can prove. These tests ask three things:
 * does it record the actions that matter (the administrative ones were recording
 * nothing at all), can an alteration be detected, and is it scoped so one firm
 * never reads another's history.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');

let env, seed, admin, pool;

test.before(async () => {
  env = await freshDatabase('audit');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_MIGRATION_URL = env.ownerUrl;
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.ADMIN_ACTOR = 'operator@uaconsulting.co';
  admin = require('../src/admin/tenants');
  pool = require('../src/db/pool');
});

test.after(async () => {
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

const ownerQuery = async (sql, params = []) => {
  const c = new Client({ connectionString: env.ownerUrl });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
};

test('creating a tenant is recorded, with the operator named', async () => {
  await admin.create({ slug: 'firm-z', name: 'Firm Z', org: 'org_zzz' });
  const { rows } = await ownerQuery(
    "SELECT * FROM audit_log WHERE action = 'tenant.created' AND subject_id IS NOT NULL ORDER BY id DESC LIMIT 1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_kind, 'operator');
  assert.equal(rows[0].actor_ref, 'operator@uaconsulting.co');
  assert.equal(rows[0].detail.slug, 'firm-z');
  // An operator is not an end user; there is no user id to attribute this to.
  assert.equal(rows[0].actor_user_id, null);
});

test('verifying a domain is recorded — the action that admits people to a firm', async () => {
  await admin.verifyDomain({ slug: 'firm-z', domain: 'firmz.com' });
  const { rows } = await ownerQuery(
    "SELECT * FROM audit_log WHERE action = 'tenant.domain_verified' ORDER BY id DESC LIMIT 1");
  assert.equal(rows[0].subject_id, 'firmz.com');
  assert.equal(rows[0].detail.domain, 'firmz.com');
});

test('suspending and revoking are recorded', async () => {
  await admin.setStatus({ slug: 'firm-z', status: 'suspended' });
  await admin.revokeSessions({ slug: 'firm-z' });
  const { rows } = await ownerQuery(
    "SELECT action FROM audit_log WHERE subject_id = 'firm-z' ORDER BY id");
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('tenant.suspended'), actions.join(','));
  assert.ok(actions.includes('tenant.sessions_revoked'), actions.join(','));
});

test('a platform event belongs to no tenant and is invisible to every tenant', async () => {
  // "A different firm was suspended" is not a customer's business.
  const platform = await ownerQuery(
    "SELECT id FROM audit_log WHERE action = 'tenant.suspended' AND tenant_id IS NULL");
  assert.ok(platform.rows.length > 0, 'suspension should be a platform-level event');

  const seen = await pool.withTenant(seed.a.tenantId, null, (db) =>
    db.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id IS NULL')
      .then((q) => q.rows[0].n));
  assert.equal(seen, 0, 'a tenant could read platform audit rows');
});

test('the chain is intact on a freshly written log', async () => {
  const { rows } = await ownerQuery('SELECT * FROM audit_log_verify()');
  assert.deepEqual(rows, [], `chain broken: ${JSON.stringify(rows)}`);
});

test('every entry commits to the one before it', async () => {
  const { rows } = await ownerQuery(
    'SELECT id, prev_hash, entry_hash FROM audit_log ORDER BY id');
  assert.ok(rows.length >= 3);
  for (let i = 1; i < rows.length; i += 1) {
    assert.deepEqual(rows[i].prev_hash, rows[i - 1].entry_hash,
      `entry ${rows[i].id} does not chain to ${rows[i - 1].id}`);
  }
});

test('editing a historical entry is DETECTED', async () => {
  // The whole point. An operator with the owner credential can perform this
  // edit — nothing stops them — and the chain is what makes it visible.
  const target = await ownerQuery(
    "SELECT id FROM audit_log WHERE action = 'tenant.domain_verified' LIMIT 1");
  const id = target.rows[0].id;
  const original = await ownerQuery('SELECT detail FROM audit_log WHERE id = $1', [id]);

  await ownerQuery(
    `UPDATE audit_log SET detail = jsonb_set(detail, '{domain}', '"attacker.com"') WHERE id = $1`,
    [id]);
  try {
    const broken = await ownerQuery('SELECT broken_at, reason FROM audit_log_verify()');
    assert.equal(broken.rows.length, 1, 'the edit was not detected');
    assert.equal(String(broken.rows[0].broken_at), String(id));
    assert.match(broken.rows[0].reason, /do not match its digest/);
  } finally {
    await ownerQuery('UPDATE audit_log SET detail = $2 WHERE id = $1', [id, original.rows[0].detail]);
  }
});

test('deleting a historical entry is DETECTED', async () => {
  // Inside a transaction that is rolled back, rather than deleted and
  // reinserted. The reinsert looked like the obvious restore and could not
  // work: audit_log_chain_trg is a BEFORE INSERT trigger, so it overwrites the
  // digests on the way back in, and writing them back afterwards still fails
  // because `at` is a timestamptz whose MICROSECONDS the driver truncates to
  // milliseconds on the round trip through a JavaScript Date — so the row that
  // returns hashes to a different value than the row that left, by a difference
  // no amount of care in the test can see.
  //
  // The old restore therefore left the chain permanently broken, which nothing
  // noticed until a later test verified the chain again. A ROLLBACK restores
  // the row bit for bit, trigger and precision included.
  const c = new Client({ connectionString: env.ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const row = await c.query('SELECT id FROM audit_log ORDER BY id LIMIT 1 OFFSET 1');
    await c.query('DELETE FROM audit_log WHERE id = $1', [row.rows[0].id]);
    const broken = await c.query('SELECT broken_at, reason FROM audit_log_verify()');
    assert.equal(broken.rows.length, 1, 'the deletion was not detected');
    assert.match(broken.rows[0].reason, /prev_hash does not match/);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  // And the log is genuinely whole again, which the old restore never achieved.
  const restored = await ownerQuery('SELECT broken_at FROM audit_log_verify()');
  assert.deepEqual(restored.rows, [], 'the rollback left the chain broken');
});

test('the application cannot forge a digest', async () => {
  // A chain computed in application code protects nothing: an attacker who
  // reaches the API writes rows with whatever digest they please. Migration 003
  // revoked table-wide INSERT so app_user cannot name the hash columns at all.
  await assert.rejects(
    () => pool.withTenant(seed.a.tenantId, null, (db) => db.query(
      `INSERT INTO audit_log (tenant_id, action, entry_hash) VALUES ($1, 'forged', '\\x00')`,
      [seed.a.tenantId])),
    /permission denied/i,
  );
});

test('the application CAN still write an ordinary entry', async () => {
  // The revoke above must not have broken the normal path.
  await pool.withTenant(seed.a.tenantId, seed.a.userId, (db) => db.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, subject_type, subject_id)
     VALUES ($1,$2,'deal.viewed','deal',$3)`,
    [seed.a.tenantId, seed.a.userId, seed.a.dealId]));

  const seen = await pool.withTenant(seed.a.tenantId, null, (db) =>
    db.query("SELECT entry_hash FROM audit_log WHERE action = 'deal.viewed'")
      .then((q) => q.rows[0]));
  assert.ok(seen.entry_hash, 'the trigger did not attach a digest');
});

test('migrating a database that ALREADY has audit rows leaves the chain verifying', async () => {
  // The bug a restore drill found, and the reason the backfill in migration 003
  // exists. The chain was added to a table that already held rows; those rows
  // had no digest, so audit_log_verify() reported the log broken on a perfectly
  // healthy system — from the first day, forever. An integrity check that cries
  // wolf immediately is an integrity check nobody consults later.
  const { Client } = require('pg');
  const { migrate } = require('../src/db/migrate');
  const { freshDatabase: fresh } = require('./helpers');

  // Build a database at migration 002 only, write audit rows into it, then
  // migrate forward — exactly the upgrade path a running system takes.
  const staged = await fresh('auditbackfill');
  const c = new Client({ connectionString: staged.ownerUrl });
  await c.connect();
  try {
    await c.query('DELETE FROM schema_migrations WHERE version >= $1', ['003_audit_integrity.sql']);
    await c.query('ALTER TABLE audit_log DROP COLUMN IF EXISTS prev_hash');
    await c.query('ALTER TABLE audit_log DROP COLUMN IF EXISTS entry_hash');
    await c.query('DROP FUNCTION IF EXISTS audit_log_verify(bigint)');
    await c.query('DROP TRIGGER IF EXISTS audit_log_chain_trg ON audit_log');

    const t = await c.query(
      "INSERT INTO tenants (slug, name, broker_org_id) VALUES ('legacy','Legacy','org_l') RETURNING id");
    for (const action of ['deal.created', 'deal.updated', 'deal.deleted']) {
      await c.query(
        'INSERT INTO audit_log (tenant_id, action, subject_type) VALUES ($1,$2,$3)',
        [t.rows[0].id, action, 'deal']);
    }
    const before = await c.query('SELECT count(*)::int AS n FROM audit_log');
    assert.equal(before.rows[0].n, 3);
  } finally {
    await c.end();
  }

  await migrate(staged.ownerUrl, { log: () => {} });

  const after = new Client({ connectionString: staged.ownerUrl });
  await after.connect();
  try {
    const unchained = await after.query(
      'SELECT count(*)::int AS n FROM audit_log WHERE entry_hash IS NULL');
    assert.equal(unchained.rows[0].n, 0, 'the backfill left rows without a digest');

    const broken = await after.query('SELECT broken_at, reason FROM audit_log_verify()');
    assert.deepEqual(broken.rows, [], `chain broken after upgrade: ${JSON.stringify(broken.rows)}`);

    // And the baseline is still real evidence going forward: edit a backfilled
    // row and the chain must notice.
    const target = await after.query('SELECT id FROM audit_log ORDER BY id LIMIT 1');
    await after.query("UPDATE audit_log SET action = 'tampered' WHERE id = $1", [target.rows[0].id]);
    const now = await after.query('SELECT broken_at FROM audit_log_verify()');
    assert.equal(now.rows.length, 1, 'a backfilled row could be edited undetected');
  } finally {
    await after.end();
    await staged.drop();
  }
});


// ─── The scheduled verifier ──────────────────────────────────────────────────
/**
 * `src/admin/verifyAudit.js` is what turns the chain from a property that can
 * be checked into one that IS checked. It runs unattended on a daily schedule
 * (infra/lib/platform.js), so nothing about its behaviour is observed by a
 * human on the day it matters — which makes these the tests that stand in for
 * that observation.
 */

test('the scheduled verifier reports an intact chain, and says so in the log', async () => {
  const { verifyAudit } = require('../src/admin/verifyAudit');
  const lines = [];
  const result = await verifyAudit({ log: (l) => lines.push(l) });
  assert.equal(result.intact, true);
  // The healthy line is not decoration: the CloudWatch alarm watches for its
  // ABSENCE, because a verification job that quietly stopped running raises no
  // alarm of its own and looks exactly like a system with nothing wrong.
  const heartbeat = JSON.parse(lines.at(-1));
  assert.equal(heartbeat.evt, 'audit_verify');
  assert.equal(heartbeat.result, 'intact');
});

test('the scheduled verifier detects a break and emits the alarm event', async () => {
  const { verifyAudit, AUDIT_CHAIN_BROKEN } = require('../src/admin/verifyAudit');
  const target = await ownerQuery("SELECT id, action FROM audit_log ORDER BY id LIMIT 1 OFFSET 2");
  const { id, action } = target.rows[0];

  const emitted = [];
  const originalError = console.error;
  console.error = (l) => emitted.push(l);
  await ownerQuery("UPDATE audit_log SET action = 'tampered' WHERE id = $1", [id]);
  try {
    const result = await verifyAudit({ log: () => {} });
    assert.equal(result.intact, false);
    assert.equal(result.brokenAt, Number(id));

    const events = emitted.map((l) => JSON.parse(l)).filter((e) => e.evt === 'security');
    assert.equal(events.length, 1, 'exactly one alarm-bearing line per break');
    // This literal is matched by the metric filter in infra/lib/platform.js and
    // pinned there by infra/test/synth.test.js. Renaming it here without
    // renaming it there produces an alarm that never fires again, silently.
    assert.equal(events[0].kind, AUDIT_CHAIN_BROKEN);
    assert.equal(events[0].kind, 'audit_chain_broken');
    assert.equal(String(events[0].brokenAt), String(id));
    assert.match(events[0].reason, /digest|prev_hash/);
  } finally {
    console.error = originalError;
    await ownerQuery('UPDATE audit_log SET action = $2 WHERE id = $1', [id, action]);
  }
});

test('the verifier runs unscoped, because the chain crosses tenants', async () => {
  // Verifying inside one tenant's row level security context walks only that
  // tenant's rows, finds their prev_hash values pointing at rows it cannot see,
  // and reports a break on a perfectly healthy log — an alarm that fires every
  // single day and is therefore ignored by the second week.
  const { verifyAudit } = require('../src/admin/verifyAudit');
  const both = await ownerQuery(
    'SELECT count(DISTINCT tenant_id) AS n FROM audit_log WHERE tenant_id IS NOT NULL');
  assert.ok(Number(both.rows[0].n) >= 2, 'this test needs entries from more than one tenant');
  const result = await verifyAudit({ log: () => {} });
  assert.equal(result.intact, true, 'a healthy multi-tenant chain must verify clean');
});


// ─── The access path, not just the SQL ───────────────────────────────────────
/**
 * Every integrity test above this point calls audit_log_verify() over the
 * fixtures' owner connection, which in this harness is a superuser and bypasses
 * row level security outright. That is the one access path no deployed caller
 * ever takes, and it hid a bug in both directions for as long as the function
 * has existed: read as app_user with no tenant, the policy matched nothing, the
 * loop never ran, and the function returned its "intact" signal on a log it had
 * not looked at; read with a tenant set, it walked one firm's rows and reported
 * a break as soon as two firms interleaved in the log.
 *
 * So these tests go through the pools the application actually uses.
 */

const verifyOver = async (tenantId = null) => {
  const { pool, withTenant } = require('../src/db/pool');
  if (tenantId === null) {
    const { rows } = await pool.query('SELECT broken_at, reason FROM audit_log_verify()');
    return rows;
  }
  return withTenant(tenantId, null, async (db) => {
    const { rows } = await db.query('SELECT broken_at, reason FROM audit_log_verify()');
    return rows;
  });
};

/**
 * Interleaved entries from both firms. The order matters: the failure these
 * tests guard against only appears once one firm's entry sits between two of
 * another's, which is the normal state of a shared log and was never the state
 * any earlier test put it in.
 *
 * Seeded lazily rather than in a second `before` hook — node:test runs a
 * file's top-level hooks in a way that does not guarantee this one sees the
 * fixtures the first has assigned.
 */
let interleaved = false;
async function seedInterleaved() {
  if (interleaved) return;
  for (let i = 0; i < 3; i += 1) {
    for (const t of [seed.a.tenantId, seed.b.tenantId]) {
      await ownerQuery(
        'INSERT INTO audit_log (tenant_id, action, subject_type) VALUES ($1,$2,$3)',
        [t, 'deal.created', 'deal']);
    }
  }
  interleaved = true;
}

test('the interleaved chain verifies clean from inside ONE tenant', async () => {
  await seedInterleaved();
  // Without migration 008 this reports a break on a healthy log the moment two
  // firms are both active: entry 7's prev_hash points at entry 6, which belongs
  // to the other firm and is invisible under the tenant policy.
  const { rows: counts } = await ownerQuery(
    'SELECT tenant_id, count(*)::int AS n FROM audit_log WHERE tenant_id IS NOT NULL GROUP BY 1');
  assert.ok(counts.length >= 2, 'this test needs entries from more than one tenant');
  assert.deepEqual(await verifyOver(seed.a.tenantId), []);
  assert.deepEqual(await verifyOver(seed.b.tenantId), []);
});

test('tampering in ANOTHER tenant is still detected', async () => {
  await seedInterleaved();
  // The chain is global. A check that only sees your own firm's rows will tell
  // you the log is intact while someone rewrites the rest of it.
  const target = await ownerQuery(
    'SELECT id, action, tenant_id FROM audit_log WHERE tenant_id = $1 ORDER BY id LIMIT 1',
    [seed.b.tenantId]);
  const { id, action } = target.rows[0];
  await ownerQuery("UPDATE audit_log SET action = 'tampered' WHERE id = $1", [id]);
  try {
    for (const [label, scope] of [['unscoped', null], ['firm A', seed.a.tenantId]]) {
      const rows = await verifyOver(scope);
      assert.equal(rows.length, 1, `${label} did not detect tampering in firm B`);
      assert.equal(String(rows[0].broken_at), String(id));
    }
  } finally {
    await ownerQuery('UPDATE audit_log SET action = $2 WHERE id = $1', [id, action]);
  }
});

test('the verifier does not become a hole in tenant isolation', async () => {
  await seedInterleaved();
  // audit_log_verify is SECURITY DEFINER and reads every tenant's rows. That is
  // only acceptable because it cannot return their CONTENTS: its return type is
  // an id and one of three fixed strings. Ordinary reads must still be scoped.
  const { withTenant } = require('../src/db/pool');
  const visible = await withTenant(seed.a.tenantId, null, async (db) => {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM audit_log');
    return rows[0].n;
  });
  const total = await ownerQuery('SELECT count(*)::int AS n FROM audit_log');
  assert.ok(visible > 0, 'firm A should see its own entries');
  assert.ok(visible < total.rows[0].n,
    'a tenant can read the whole audit log — the definer function has leaked the table');
});

test('the owner policy grants reads and nothing more', async () => {
  // The definer function needs SELECT and only SELECT. Widening this to FOR ALL
  // would hand the owner a policy-blessed path to UPDATE and DELETE audit rows
  // — which is the exact operation the hash chain exists to make evident.
  const { rows } = await ownerQuery(`
    SELECT polcmd FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'audit_log' AND p.polname = 'audit_log_owner_read'`);
  assert.equal(rows.length, 1, 'the owner read policy is missing');
  // 'r' is SELECT. '*' would be ALL.
  assert.equal(rows[0].polcmd, 'r', `the policy covers ${rows[0].polcmd}, not just SELECT`);
});

test('the migration REFUSES a cluster where app_user can bypass RLS', async () => {
  /**
   * The guarantee that replaced an assumption.
   *
   * Setting NOSUPERUSER/NOBYPASSRLS takes superuser, which the migration role
   * deliberately is not — so the ALTER in migration 001 can be refused. If it
   * were refused silently, an app_user left over from another cluster with
   * BYPASSRLS would be admitted, and every tenant policy in this schema would
   * be inert while every test and every review still read as though they bind.
   *
   * There is no worse failure available in a multi-tenant system than one where
   * isolation is absent and everything looks correct, so the migration now
   * verifies the attributes and refuses the database outright.
   */
  const { migrate } = require('../src/db/migrate');
  const admin = new Client({ connectionString: require('./helpers').ADMIN });
  await admin.connect();
  // An UNMIGRATED database: the runner records what it has applied and skips it
  // on a second pass, so re-migrating an already-healthy database would never
  // reach the check and the test would pass for the wrong reason.
  const staged = await freshDatabase('bypassrls', { applyMigrations: false });
  try {
    // Roles are cluster-wide, so this is visible to the staged database too.
    await admin.query('ALTER ROLE app_user BYPASSRLS');
    await assert.rejects(
      () => migrate(staged.migrationUrl, { log: () => {} }),
      /BYPASSRLS|NOSUPERUSER/,
      'a cluster where app_user bypasses row level security was migrated anyway',
    );
  } finally {
    // Restore before anything else runs: the suite is serial, and leaving this
    // set would disable tenant isolation for every later test in the run.
    await admin.query('ALTER ROLE app_user NOBYPASSRLS');
    await admin.end();
    await staged.drop();
  }
});
