'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { freshDatabase } = require('./helpers');

let env, seedDemo, list;

test.before(async () => {
  env = await freshDatabase('seed');
  process.env.DATABASE_MIGRATION_URL = env.ownerUrl;
  ({ seedDemo } = require('../src/admin/seedDemo'));
  ({ list } = require('../src/admin/tenants'));
});
test.after(async () => { if (env) await env.drop(); });

test('seeding creates two tenants with verified domains', async () => {
  // Two, because one tenant demonstrates a login and two demonstrate the
  // boundary the product is sold on.
  await seedDemo({ log: () => {} });
  const rows = await list();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.slug).sort(), ['firm-x', 'firm-y']);
  for (const r of rows) {
    assert.equal(r.domains.length, 1);
    assert.equal(r.status, 'active');
  }
});

test('seeding twice is a no-op, not an error', async () => {
  // `docker compose up` a second time must not fail on a duplicate slug.
  await seedDemo({ log: () => {} });
  assert.equal((await list()).length, 2);
});
