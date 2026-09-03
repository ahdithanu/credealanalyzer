'use strict';

/**
 * Tenant onboarding.
 *
 * Onboarding writes the two facts the login path trusts absolutely: the broker
 * organization id that decides which firm a user belongs to, and whether an
 * email domain is verified for that firm. Getting either wrong admits the wrong
 * people into a client's data, so the guards are tested rather than assumed.
 */

const test = require('node:test');
const assert = require('node:assert');
const { freshDatabase } = require('./helpers');

let env, admin;

test.before(async () => {
  env = await freshDatabase('admin');
  process.env.DATABASE_MIGRATION_URL = env.ownerUrl;
  admin = require('../src/admin/tenants');
});

test.after(async () => { if (env) await env.drop(); });

test('creating a tenant records the broker organization id', async () => {
  const t = await admin.create({ slug: 'firm-a', name: 'Firm A', org: 'org_aaa' });
  assert.equal(t.slug, 'firm-a');
  assert.equal(t.broker_org_id, 'org_aaa');
  assert.equal(t.status, 'active');
});

test('a broker organization id cannot be pointed at a second tenant', async () => {
  // The most dangerous mistake available here: repointing an existing firm's
  // identity provider at a tenant someone else controls. The schema's UNIQUE
  // constraint makes it fail rather than silently succeed.
  await assert.rejects(
    () => admin.create({ slug: 'firm-b', name: 'Firm B', org: 'org_aaa' }),
    /duplicate key|unique/i,
  );
});

test('a slug is validated rather than trusted', async () => {
  for (const slug of ['', 'A', 'x', 'has space', 'has_underscore', '-lead', 'a'.repeat(64), '../etc']) {
    await assert.rejects(
      () => admin.create({ slug, name: 'X', org: `org_${Math.random()}` }),
      /--slug/,
      `slug ${JSON.stringify(slug)} was accepted`,
    );
  }
});

test('verifying a domain admits that domain and no other', async () => {
  const d = await admin.verifyDomain({ slug: 'firm-a', domain: 'FirmA.com' });
  assert.equal(d.domain, 'firma.com', 'the domain was not normalised to lowercase');
  assert.ok(d.verified_at);
});

test('a malformed domain is refused', async () => {
  for (const domain of [
    '', 'not a domain', 'firma', '.firma.com', 'firma..com', 'http://firma.com',
    'firma.com/path', '-firma.com', 'firma-.com', 'a@firma.com', '*.firma.com',
  ]) {
    await assert.rejects(
      () => admin.verifyDomain({ slug: 'firm-a', domain }),
      /--domain/,
      `domain ${JSON.stringify(domain)} was accepted`,
    );
  }
});

test('one domain cannot be verified for two tenants', async () => {
  // Two firms both claiming acme.com makes the login path's domain check
  // ambiguous, and which tenant a user landed in would depend on row order.
  await admin.create({ slug: 'firm-c', name: 'Firm C', org: 'org_ccc' });
  await assert.rejects(
    () => admin.verifyDomain({ slug: 'firm-c', domain: 'firma.com' }),
    /already verified for tenant firm-a/,
  );
});

test('verifying a domain for an unknown tenant fails', async () => {
  await assert.rejects(
    () => admin.verifyDomain({ slug: 'no-such-firm', domain: 'x.com' }),
    /no tenant with slug/,
  );
});

test('list reports domains, users and deal counts per tenant', async () => {
  const rows = await admin.list();
  const a = rows.find((r) => r.slug === 'firm-a');
  assert.deepEqual(a.domains, ['firma.com']);
  assert.equal(Number(a.users), 0);
  assert.equal(Number(a.deals), 0);
});

test('suspend and activate move the status the login path reads', async () => {
  assert.equal((await admin.setStatus({ slug: 'firm-a', status: 'suspended' })).status, 'suspended');
  assert.equal((await admin.setStatus({ slug: 'firm-a', status: 'active' })).status, 'active');
  await assert.rejects(
    () => admin.setStatus({ slug: 'nope', status: 'suspended' }),
    /no tenant with slug/,
  );
});

test('an invalid status is refused by the schema, not silently stored', async () => {
  // A status the login path does not recognise would be treated as
  // not-active and lock a paying firm out, or worse, be read as active.
  await assert.rejects(
    () => admin.setStatus({ slug: 'firm-a', status: 'kind-of-active' }),
    /check constraint|invalid/i,
  );
});

test('revoke-sessions reports how many it ended', async () => {
  const r = await admin.revokeSessions({ slug: 'firm-a' });
  assert.equal(r.slug, 'firm-a');
  assert.equal(typeof r.revoked, 'number');
});
