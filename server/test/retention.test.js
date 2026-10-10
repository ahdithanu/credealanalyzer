'use strict';

/**
 * Retention, purging and offboarding.
 *
 * Two things are being proved here. First, that the destructive commands are
 * hard to fire by accident — the default is a report, the window is explicit
 * about where it came from, and a purge that cannot be audited does not happen.
 * Second, that crypto-shredding actually resolves the conflict it was chosen to
 * resolve: after an offboarding the tenant's payloads cannot be opened by
 * anyone, and the append-only hash chain still verifies end to end.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const { freshDatabase } = require('./helpers');

process.env.KEY_PROVIDER = 'local';
process.env.LOCAL_MASTER_KEY = 'test-master-key-for-the-retention-suite-012345';
// Set explicitly so the override is exercised and the assertions below are not
// quietly asserting the code's own constant back at itself.
process.env.RETENTION_DEFAULT_DAYS = '60';

let env, retention, pool, keyring, tenants;

/** Tenant ids, keyed by slug. */
const T = {};

test.before(async () => {
  env = await freshDatabase('retention');
  process.env.DATABASE_MIGRATION_URL = env.migrationUrl;
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.ADMIN_ACTOR = 'operator@uaconsulting.co';

  retention = require('../src/admin/retention');
  tenants = require('../src/admin/tenants');
  pool = require('../src/db/pool');
  keyring = require('../src/crypto/keyring');

  for (const [slug, name, org] of [
    ['firm-p', 'Firm Purge', 'org_p'],
    ['firm-o', 'Firm Offboard', 'org_o'],
    ['firm-q', 'Firm Quiet', 'org_q'],
  ]) {
    const t = await tenants.create({ slug, name, org });
    T[slug] = t.id;
    await tenants.verifyDomain({ slug, domain: `${slug.replace('-', '')}.com` });
    await ownerQuery(
      'INSERT INTO users (tenant_id, email, name, role) VALUES ($1,$2,$3,$4)',
      [t.id, `admin@${slug.replace('-', '')}.com`, 'An Admin', 'admin']);
  }
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

/** An encrypted deal, optionally soft-deleted `ageDays` ago. */
async function makeDeal(tenantId, name, payload, ageDays = null) {
  const ct = await pool.withTenant(tenantId, null, (db) => keyring.sealPayload(db, tenantId, payload));
  const { rows } = await ownerQuery(
    `INSERT INTO deals (tenant_id, name, payload, payload_ct, deleted_at)
     VALUES ($1,$2,NULL,$3, CASE WHEN $4::int IS NULL THEN NULL
                                 ELSE now() - make_interval(days => $4) END)
     RETURNING id`,
    [tenantId, name, ct, ageDays],
  );
  return rows[0].id;
}

const slugOf = (report, slug) => report.tenants.find((t) => t.slug === slug);

// ─── The window ──────────────────────────────────────────────────────────────

test('an unset window is the platform default, and says so', async () => {
  // NULL means "nobody set one", not zero and not "never". A report that does
  // not distinguish the two invites an operator to read a default as a
  // negotiated term.
  assert.equal(retention.PLATFORM_DEFAULT_RETENTION_DAYS, 60);
  const [row] = await retention.show({ tenant: 'firm-p' });
  assert.equal(row.retentionDays, 60);
  assert.equal(row.retentionSource, 'platform-default');
});

test('a per-tenant window overrides it, and clearing restores it', async () => {
  const set = await retention.setRetention({ slug: 'firm-p', days: 30 });
  assert.deepEqual(set, { slug: 'firm-p', retentionDays: 30, retentionSource: 'tenant' });
  assert.equal((await retention.show({ tenant: 'firm-p' }))[0].retentionSource, 'tenant');

  // Clearing is spelled 'none'. It is NOT "a very large number", which would be
  // a different and permanent policy wearing the same clothes.
  const cleared = await retention.setRetention({ slug: 'firm-p', days: 'none' });
  assert.deepEqual(cleared, { slug: 'firm-p', retentionDays: 60, retentionSource: 'platform-default' });
  assert.equal(
    (await ownerQuery('SELECT retention_days FROM tenants WHERE slug = $1', ['firm-p'])).rows[0].retention_days,
    null);
});

test('a zero or negative window is refused by the CLI and by the schema', async () => {
  // Zero means "purge the moment a deal is deleted", which removes the recovery
  // window that is the entire reason the delete is soft.
  for (const days of [0, -1, 1.5, 'lots']) {
    await assert.rejects(() => retention.setRetention({ slug: 'firm-p', days }), /--days/,
      `--days ${days} was accepted`);
  }
  await assert.rejects(
    () => ownerQuery('UPDATE tenants SET retention_days = 0 WHERE slug = $1', ['firm-p']),
    /tenants_retention_days_positive|check constraint/i,
  );
});

test('setting a window on an unknown tenant fails', async () => {
  await assert.rejects(() => retention.setRetention({ slug: 'no-such-firm', days: 30 }),
    /no tenant with slug/);
});

test('the window change is audited', async () => {
  await retention.setRetention({ slug: 'firm-q', days: 14 });
  const { rows } = await ownerQuery(
    "SELECT * FROM audit_log WHERE action = 'tenant.retention_set' ORDER BY id DESC LIMIT 1");
  assert.equal(rows[0].actor_kind, 'operator');
  assert.equal(rows[0].subject_id, 'firm-q');
  assert.equal(rows[0].detail.retentionDays, 14);
  assert.equal(rows[0].detail.source, 'tenant');
  await retention.setRetention({ slug: 'firm-q', days: 'none' });
});

// ─── Purge ───────────────────────────────────────────────────────────────────

test('a purge with no --apply deletes nothing', async () => {
  // A deletion tool whose default is to delete is a deletion tool that will one
  // day be run with the wrong argument.
  await makeDeal(T['firm-p'], 'Ancient', { purchasePrice: 1 }, 400);
  await makeDeal(T['firm-p'], 'Recent', { purchasePrice: 2 }, 3);
  await makeDeal(T['firm-p'], 'Live', { purchasePrice: 3 }, null);

  const report = await retention.purge({ log: () => {} });
  assert.equal(report.apply, false);
  const p = slugOf(report, 'firm-p');
  assert.equal(p.eligible, 1, 'the wrong number of deals is past the window');
  assert.equal(p.dryRun, true);
  // NULL, not 0. Nothing was purged because nothing was attempted, and
  // "purged: 0" beside "eligible: 1" reads as "there was nothing to do".
  assert.equal(p.purged, null);

  assert.equal(
    (await ownerQuery('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1', [T['firm-p']])).rows[0].n,
    3, 'a dry run deleted rows');
});

test('a purge removes only soft-deleted deals past the window', async () => {
  const report = await retention.purge({ apply: true, tenant: 'firm-p', log: () => {} });
  assert.equal(slugOf(report, 'firm-p').purged, 1);

  const left = await ownerQuery(
    'SELECT name, deleted_at FROM deals WHERE tenant_id = $1 ORDER BY name', [T['firm-p']]);
  assert.deepEqual(left.rows.map((r) => r.name), ['Live', 'Recent']);
  // The live deal is untouched, which is the failure that would end the company.
  assert.equal(left.rows.find((r) => r.name === 'Live').deleted_at, null);
});

test('the purge is audited with the exact set it removed', async () => {
  const id = await makeDeal(T['firm-p'], 'Audited Purge', { purchasePrice: 4 }, 200);
  await retention.purge({ apply: true, tenant: 'firm-p', log: () => {} });

  const { rows } = await ownerQuery(
    "SELECT * FROM audit_log WHERE action = 'deal.purged' ORDER BY id DESC LIMIT 1");
  assert.equal(rows[0].actor_kind, 'operator');
  assert.equal(rows[0].actor_ref, 'operator@uaconsulting.co');
  assert.equal(rows[0].detail.purged, 1);
  assert.deepEqual(rows[0].detail.dealIds, [id]);
  assert.equal(rows[0].detail.retentionDays, 60);
  assert.equal(rows[0].detail.retentionSource, 'platform-default');
  // The entry must not reconstitute what the purge removed.
  assert.ok(!JSON.stringify(rows[0].detail).includes('Audited Purge'));
});

test('a purge that cannot be audited does not happen', async () => {
  // A purge that is not audited is indistinguishable from a breach, so the
  // entry and the deletion commit together or not at all. Proved by breaking
  // the audit trigger and confirming the rows survive.
  const id = await makeDeal(T['firm-p'], 'Survives', { purchasePrice: 5 }, 300);
  const def = (await ownerQuery(
    "SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = 'audit_log_chain'")).rows[0].d;

  await ownerQuery(`CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit is unavailable'; END $$`);
  try {
    await assert.rejects(
      () => retention.purge({ apply: true, tenant: 'firm-p', log: () => {} }),
      /audit entry could not be written/,
      'the purge reported success while the audit entry was lost',
    );
  } finally {
    await ownerQuery(def);
  }

  assert.equal(
    (await ownerQuery('SELECT count(*)::int AS n FROM deals WHERE id = $1', [id])).rows[0].n,
    1, 'deals were destroyed without a record');

  // And with the trigger restored it goes through, so the guard is not simply
  // a broken purge.
  await retention.purge({ apply: true, tenant: 'firm-p', log: () => {} });
  assert.equal(
    (await ownerQuery('SELECT count(*)::int AS n FROM deals WHERE id = $1', [id])).rows[0].n, 0);
});

test('naming one tenant purges only that tenant', async () => {
  await makeDeal(T['firm-q'], 'Untouched', { purchasePrice: 6 }, 500);
  await makeDeal(T['firm-p'], 'Targeted', { purchasePrice: 7 }, 500);
  const report = await retention.purge({ apply: true, tenant: 'firm-p', log: () => {} });
  assert.equal(report.tenants.length, 1);
  assert.equal(
    (await ownerQuery('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1', [T['firm-q']])).rows[0].n,
    1, 'a purge aimed at one firm reached another');
});

test('a shorter per-tenant window is honoured', async () => {
  await retention.setRetention({ slug: 'firm-q', days: 1 });
  const report = await retention.purge({ apply: true, tenant: 'firm-q', log: () => {} });
  const q = slugOf(report, 'firm-q');
  assert.equal(q.retentionDays, 1);
  assert.equal(q.retentionSource, 'tenant');
  assert.equal(q.purged, 1);
  await retention.setRetention({ slug: 'firm-q', days: 'none' });
});

test('purging an unknown tenant fails rather than purging everything', async () => {
  // The typo that would otherwise run the platform-wide purge.
  await assert.rejects(() => retention.purge({ apply: true, tenant: 'firm-typo', log: () => {} }),
    /no tenant with slug/);
});

test('an invalid platform default refuses to load rather than defaulting', () => {
  const run = (value) => {
    try {
      execFileSync(process.execPath,
        ['-e', "require('./src/admin/retention'); console.log('LOADED');"],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8',
          env: { ...process.env, RETENTION_DEFAULT_DAYS: value }, stdio: 'pipe' });
      return 'LOADED';
    } catch (e) {
      return String(e.stderr);
    }
  };
  assert.match(run('0'), /RETENTION_DEFAULT_DAYS must be a whole number/);
  assert.match(run('forever'), /RETENTION_DEFAULT_DAYS must be a whole number/);
  assert.equal(run('45'), 'LOADED');
});

// ─── Offboarding ─────────────────────────────────────────────────────────────

test('offboarding with no --apply destroys nothing', async () => {
  await makeDeal(T['firm-o'], 'Still Here', { purchasePrice: 8 }, null);
  const plan = await retention.offboard({ slug: 'firm-o', log: () => {} });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.deals, 1);
  assert.equal(plan.users, 1);
  assert.equal(plan.domains, 1);
  assert.ok(plan.auditEntries > 0);
  // Not `false`: nothing was attempted, so this is not a report that the key
  // survived an attempt to destroy it.
  assert.equal(plan.keyDestroyed, null);

  const t = await ownerQuery('SELECT status, offboarded_at FROM tenants WHERE slug = $1', ['firm-o']);
  assert.equal(t.rows[0].status, 'active');
  assert.equal(t.rows[0].offboarded_at, null);
  assert.equal(
    (await ownerQuery('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1', [T['firm-o']])).rows[0].n, 1);
});

test('offboarding deletes the tenant\'s rows, shreds the key, and keeps the trail', async () => {
  const tenantId = T['firm-o'];
  await pool.withTenant(tenantId, null, (db) => db.query(
    `INSERT INTO firm_defaults (tenant_id, version, assumptions)
     VALUES ($1,'2026.1','{"minDscr":1.25}')`, [tenantId]));
  const userId = (await ownerQuery('SELECT id FROM users WHERE tenant_id = $1', [tenantId])).rows[0].id;
  await ownerQuery(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at)
     VALUES (digest('live','sha256'), $1, $2, now() + interval '1 hour')`, [userId, tenantId]);

  // Keep a copy of a sealed payload so the shredding can be demonstrated rather
  // than asserted: after the key is destroyed this blob must be unopenable.
  await makeDeal(tenantId, 'Confidential', { sponsor: 'Harbour Point', irr: 0.24 }, null);
  const sealed = (await ownerQuery(
    "SELECT payload_ct FROM deals WHERE tenant_id = $1 AND name = 'Confidential'",
    [tenantId])).rows[0].payload_ct;
  const auditBefore = (await ownerQuery(
    'SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [tenantId])).rows[0].n;

  const done = await retention.offboard({
    slug: 'firm-o', apply: true, reason: 'TICKET-123', log: () => {} });
  assert.equal(done.dryRun, false);
  assert.equal(done.keyDestroyed, true);
  assert.equal(done.deals, 2);
  assert.equal(done.users, 1);
  assert.equal(done.firmDefaults, 1);
  assert.equal(done.domains, 1);

  for (const table of ['deals', 'users', 'firm_defaults', 'tenant_domains']) {
    assert.equal(
      (await ownerQuery(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0].n,
      0, `${table} rows survived the offboarding`);
  }
  assert.equal(
    (await ownerQuery(
      'SELECT count(*)::int AS n FROM sessions WHERE tenant_id = $1 AND revoked_at IS NULL',
      [tenantId])).rows[0].n, 0, 'a live session survived the offboarding');

  const t = (await ownerQuery(
    'SELECT status, offboarded_at FROM tenants WHERE slug = $1', ['firm-o'])).rows[0];
  assert.equal(t.status, 'suspended');
  assert.ok(t.offboarded_at, 'the tenancy was not marked as ended');

  const key = (await ownerQuery(
    'SELECT wrapped_key, destroyed_at, destroyed_by FROM tenant_keys WHERE tenant_id = $1',
    [tenantId])).rows[0];
  assert.equal(key.wrapped_key, null, 'the wrapped key is still there');
  assert.ok(key.destroyed_at);
  assert.equal(key.destroyed_by, 'TICKET-123');

  // THE ERASURE, demonstrated. The ciphertext still exists in the copy taken
  // above — as it would in every backup, replica and WAL archive — and it
  // cannot be opened by anyone, including us.
  const attempt = await pool.withTenant(tenantId, null,
    (db) => keyring.openPayload(db, tenantId, { payload_ct: sealed }));
  assert.deepEqual(attempt, { payload: null, payloadError: 'key_destroyed' });
  assert.ok(!sealed.toString('latin1').includes('Harbour Point'));

  // And the trail the chain depends on is intact, which is the whole reason
  // crypto-shredding was chosen over deleting audit rows.
  const auditAfter = (await ownerQuery(
    'SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [tenantId])).rows[0].n;
  assert.ok(auditAfter > auditBefore,
    'the offboarding deleted audit entries instead of keeping them');
});

test('the audit chain still verifies after an offboarding', async () => {
  // The conflict this design exists to resolve. Honour an erasure by deleting
  // audit rows and this goes red — and from then on a lawful deletion is
  // indistinguishable from an attacker editing their own tracks.
  const broken = await ownerQuery('SELECT broken_at, reason FROM audit_log_verify()');
  assert.deepEqual(broken.rows, [], `chain broken: ${JSON.stringify(broken.rows)}`);
});

test('the offboarding entry states its own basis', async () => {
  const { rows } = await ownerQuery(
    "SELECT * FROM audit_log WHERE action = 'tenant.offboarded' ORDER BY id DESC LIMIT 1");
  assert.equal(rows[0].subject_id, 'firm-o');
  assert.equal(rows[0].detail.reason, 'TICKET-123');
  assert.equal(rows[0].detail.dataKeyDestroyed, true);
  assert.equal(rows[0].detail.dealsDeleted, 2);
  assert.match(rows[0].detail.basis, /crypto-shredding/);
  // The entry is what someone reads two years later, so it must say what was
  // KEPT as well as what went.
  assert.ok(rows[0].detail.auditEntriesRetained > 0);
});

test('offboarding twice is idempotent, not a second erasure', async () => {
  const again = await retention.offboard({ slug: 'firm-o', apply: true, log: () => {} });
  assert.equal(again.alreadyOffboarded, true);
  const entries = (await ownerQuery(
    "SELECT count(*)::int AS n FROM audit_log WHERE action = 'tenant.offboarded'")).rows[0].n;
  assert.equal(entries, 1, 'a re-run recorded a second offboarding that did not happen');
});

test('an offboarded tenant cannot be reached, and the key is not silently reissued', async () => {
  // A tenant whose key row was DELETED would look to the application like a
  // tenant that never had one, and the next write would mint a fresh key —
  // quietly making an offboarded firm writable again. The tombstone is what
  // prevents that.
  await assert.rejects(
    () => pool.withTenant(T['firm-o'], null,
      (db) => keyring.sealPayload(db, T['firm-o'], { anything: true })),
    /has been destroyed/,
  );
  const key = await ownerQuery(
    'SELECT count(*)::int AS n FROM tenant_keys WHERE tenant_id = $1 AND destroyed_at IS NOT NULL',
    [T['firm-o']]);
  assert.equal(key.rows[0].n, 1);
});

test('offboarding an unknown tenant fails', async () => {
  await assert.rejects(() => retention.offboard({ slug: 'no-such-firm', apply: true, log: () => {} }),
    /no tenant with slug/);
  await assert.rejects(() => retention.offboard({ slug: 'Bad Slug!', log: () => {} }), /--slug/);
});

test('show reports the ended tenancy distinctly from a suspension', async () => {
  // Suspended is reversible — non-payment, a security hold. Offboarded is not.
  // Reading one as the other is how a firm that missed an invoice gets treated
  // as a firm that left.
  const rows = await retention.show();
  const off = rows.find((r) => r.slug === 'firm-o');
  assert.ok(off.offboardedAt);
  assert.ok(off.keyDestroyedAt);
  assert.equal(off.liveDeals, 0);
  assert.equal(off.softDeletedDeals, 0);

  await tenants.setStatus({ slug: 'firm-q', status: 'suspended' });
  const suspended = (await retention.show({ tenant: 'firm-q' }))[0];
  assert.equal(suspended.status, 'suspended');
  assert.equal(suspended.offboardedAt, null, 'a suspension was reported as an offboarding');
  assert.equal(suspended.keyDestroyedAt, null);
  await tenants.setStatus({ slug: 'firm-q', status: 'active' });
});

describe_erasure_honesty();

function describe_erasure_honesty() {
  const assert2 = require('node:assert');
  const test2 = require('node:test');

  /**
   * What offboarding is ENTITLED to claim.
   *
   * The original implementation asserted crypto-shredding as a legal basis
   * inside the audit entry, and it was false: the wrapped data key lives in the
   * same database as the ciphertext, so a restored snapshot plus the still-live
   * master key recovers the payload in full. A verifier did exactly that.
   *
   * These tests pin the honest version. The claim must track the provider's
   * actual reach, and under the local provider — which derives every tenant key
   * from one platform master secret — the strong claim must never appear.
   */
  test2('the local provider does not claim to reach backups', () => {
    const { LocalKeyProvider } = require('../src/crypto/keyProvider');
    const p = new LocalKeyProvider('a'.repeat(64));
    assert2.equal(p.shreddingReachesBackups, false,
      'a single platform master key cannot support an erasure claim about backups');
  });

  test2('a shared KMS key does not claim to reach backups; a per-tenant key does', () => {
    const { AwsKmsKeyProvider } = require('../src/crypto/keyProvider');
    const shared = new AwsKmsKeyProvider('alias/shared', { client: {}, perTenantKeys: false });
    const perTenant = new AwsKmsKeyProvider('alias/shared', { client: {}, perTenantKeys: true });
    assert2.equal(shared.shreddingReachesBackups, false);
    assert2.equal(perTenant.shreddingReachesBackups, true);
  });

  test2('a shared key reports why it destroyed nothing rather than staying silent', async () => {
    const { AwsKmsKeyProvider } = require('../src/crypto/keyProvider');
    const shared = new AwsKmsKeyProvider('alias/shared', { client: {}, perTenantKeys: false });
    const r = await shared.destroyTenantKeyMaterial('00000000-0000-0000-0000-000000000000');
    assert2.equal(r.destroyed, false);
    assert2.equal(r.reason, 'shared-cmk');
  });

  test2('the offboarding record states the WEAKER truth under the local provider', async () => {
    // The entry a customer would be shown. Under local it must not say
    // crypto-shredding, because a snapshot still opens.
    const { Client } = require('pg');
    const c = new Client({ connectionString: env.ownerUrl });
    await c.connect();
    try {
      await c.query(
        "INSERT INTO tenants (slug, name, broker_org_id) VALUES ('erasure-probe','EP','org_ep')");
      await retention.offboard({ slug: 'erasure-probe', apply: true, reason: 'TICKET-1' });

      const { rows } = await c.query(
        "SELECT detail FROM audit_log WHERE action = 'tenant.offboarded' AND subject_id = 'erasure-probe'");
      assert2.equal(rows.length, 1);
      const d = rows[0].detail;
      assert2.equal(d.erasure.reachesBackups, false,
        'the local provider must not claim its erasure reaches backups');
      assert2.match(d.basis, /NOT crypto-shredding/,
        `the basis overclaims: ${d.basis}`);
      assert2.ok(!/^crypto-shredding/.test(d.basis));
    } finally {
      await c.end();
    }
  });
}
