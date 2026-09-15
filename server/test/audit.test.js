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
  const row = await ownerQuery('SELECT * FROM audit_log ORDER BY id LIMIT 1 OFFSET 1');
  const kept = row.rows[0];
  await ownerQuery('DELETE FROM audit_log WHERE id = $1', [kept.id]);
  try {
    const broken = await ownerQuery('SELECT broken_at, reason FROM audit_log_verify()');
    assert.equal(broken.rows.length, 1, 'the deletion was not detected');
    assert.match(broken.rows[0].reason, /prev_hash does not match/);
  } finally {
    // Restore it so later tests see an intact chain. The digest columns are
    // written back verbatim, which is only possible as the owner.
    await ownerQuery(
      `INSERT INTO audit_log (id, tenant_id, actor_user_id, actor_kind, actor_ref, action,
                              subject_type, subject_id, detail, ip, at, prev_hash, entry_hash)
       OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [kept.id, kept.tenant_id, kept.actor_user_id, kept.actor_kind, kept.actor_ref,
        kept.action, kept.subject_type, kept.subject_id, kept.detail, kept.ip, kept.at,
        kept.prev_hash, kept.entry_hash],
    ).catch(async () => {
      // bigserial is not an identity column, so OVERRIDING may be rejected.
      await ownerQuery(
        `INSERT INTO audit_log (id, tenant_id, actor_user_id, actor_kind, actor_ref, action,
                                subject_type, subject_id, detail, ip, at, prev_hash, entry_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [kept.id, kept.tenant_id, kept.actor_user_id, kept.actor_kind, kept.actor_ref,
          kept.action, kept.subject_type, kept.subject_id, kept.detail, kept.ip, kept.at,
          kept.prev_hash, kept.entry_hash],
      );
    });
  }
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
