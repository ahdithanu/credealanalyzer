'use strict';

/**
 * Per-tenant envelope encryption.
 *
 * Volume encryption protects a stolen disk. It does nothing about a stolen
 * CREDENTIAL, which is the likelier incident by a wide margin: anyone who
 * reaches the database reads every firm's deal terms. These tests ask whether
 * that is still true, and they ask it by READING THE RAW COLUMN BACK rather
 * than by trusting that a function named `seal` sealed anything.
 *
 * The attack with its own test is the one the additional authenticated data
 * exists for: a ciphertext lifted out of one firm's row and pasted into
 * another's must fail to open, not open into the wrong firm.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const nodeCrypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');

process.env.SSO_PROVIDER = 'stub';
process.env.KEY_PROVIDER = 'local';
process.env.LOCAL_MASTER_KEY = 'test-master-key-for-the-crypto-suite-0123456789';

let env, seed, server, base, login, stub, pool, envelope, keyProviderMod, keyring, backfillMod;

test.before(async () => {
  env = await freshDatabase('crypto');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.DATABASE_MIGRATION_URL = env.ownerUrl;
  process.env.APP_ORIGIN = 'http://localhost:3000';
  process.env.ADMIN_ACTOR = 'operator@uaconsulting.co';

  login = require('../src/auth/login');
  pool = require('../src/db/pool');
  envelope = require('../src/crypto/envelope');
  keyProviderMod = require('../src/crypto/keyProvider');
  keyring = require('../src/crypto/keyring');
  backfillMod = require('../src/crypto/backfill');
  stub = require('../src/auth/broker').broker();

  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

const ownerQuery = async (sql, params = []) => {
  const c = new Client({ connectionString: env.ownerUrl });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
};

/** Sign in and return a client bound to that session. */
async function signIn(org, email) {
  const begun = await login.begin({ redirectTo: '/' });
  const code = new URL(begun.url).searchParams.get('code');
  stub.__setProfile(code, {
    organizationId: org, email, emailVerified: true, externalId: `idp|${email}`,
    name: 'Test User', connectionId: 'conn', idpName: 'stub',
  });
  const done = await login.complete({ state: begun.state, code, ip: '198.51.100.1' });
  const cookie = `cre_session=${encodeURIComponent(done.token)}`;
  const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
  const call = (p, init = {}) => fetch(`${base}${p}`, {
    ...init,
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      ...(init.method && !['GET', 'HEAD'].includes(init.method)
        ? { 'x-csrf-token': me.csrfToken } : {}),
      ...(init.headers || {}),
    },
  });
  return { call, me };
}

// ─── The blob format ─────────────────────────────────────────────────────────

test('a sealed payload round trips', () => {
  const key = nodeCrypto.randomBytes(32);
  const blob = envelope.seal(key, seed.a.tenantId, Buffer.from('{"purchasePrice":42}'));
  assert.equal(
    envelope.open(key, seed.a.tenantId, blob).toString('utf8'),
    '{"purchasePrice":42}');
});

test('the sealed blob does not contain the plaintext', () => {
  const key = nodeCrypto.randomBytes(32);
  const secret = 'CapRateIs0475AndTheSellerIsMotivated';
  const blob = envelope.seal(key, seed.a.tenantId, Buffer.from(secret));
  assert.ok(!blob.toString('utf8').includes(secret));
  assert.ok(!blob.toString('latin1').includes(secret));
});

test('a modified ciphertext fails to open rather than opening to garbage', () => {
  // AES-GCM is authenticated; this is what "authenticated" buys. Without the
  // tag check a flipped bit would yield plausible-looking bytes that a JSON
  // parser might, on a bad day, accept.
  const key = nodeCrypto.randomBytes(32);
  const blob = envelope.seal(key, seed.a.tenantId, Buffer.from('{"purchasePrice":42}'));
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => envelope.open(key, seed.a.tenantId, tampered));
});

test('a blob sealed for one tenant cannot be opened as another', () => {
  // THE ATTACK. The tenant id is the additional authenticated data, so this is
  // a tag failure, not a decryption into the wrong firm's screen.
  const key = nodeCrypto.randomBytes(32);
  const blob = envelope.seal(key, seed.a.tenantId, Buffer.from('{"purchasePrice":42}'));
  assert.throws(() => envelope.open(key, seed.b.tenantId, blob),
    /unable to authenticate|unsupported state/i);
});

test('a truncated or wrongly versioned blob is refused', () => {
  const key = nodeCrypto.randomBytes(32);
  assert.throws(() => envelope.open(key, seed.a.tenantId, Buffer.alloc(4)), /truncated/);
  const blob = envelope.seal(key, seed.a.tenantId, Buffer.from('x'));
  const future = Buffer.from(blob);
  future[0] = 99;
  assert.throws(() => envelope.open(key, seed.a.tenantId, future), /unsupported version/);
});

test('a key of the wrong size is refused rather than stretched', () => {
  assert.throws(() => envelope.seal(nodeCrypto.randomBytes(16), seed.a.tenantId, Buffer.from('x')),
    /key must be 32 bytes/);
});

// ─── The provider interface ──────────────────────────────────────────────────

test('the local provider wraps and unwraps a data key', async () => {
  const p = new keyProviderMod.LocalKeyProvider('a-master-key-for-this-test');
  const { plaintext, wrapped } = await p.generateDataKey(seed.a.tenantId);
  assert.equal(plaintext.length, 32);
  assert.ok(!wrapped.equals(plaintext), 'the wrapped key is the plaintext key');
  assert.ok((await p.unwrapDataKey(seed.a.tenantId, wrapped)).equals(plaintext));
});

test('a wrapped key cannot be unwrapped for a different tenant', async () => {
  // The same defence one level up: a tenant_keys row copied between tenants is
  // as useless as a payload copied between them.
  const p = new keyProviderMod.LocalKeyProvider('a-master-key-for-this-test');
  const { wrapped } = await p.generateDataKey(seed.a.tenantId);
  await assert.rejects(() => p.unwrapDataKey(seed.b.tenantId, wrapped));
});

test('a different master key cannot unwrap, and the masters are distinguishable', async () => {
  const one = new keyProviderMod.LocalKeyProvider('master-one');
  const two = new keyProviderMod.LocalKeyProvider('master-two');
  assert.notEqual(one.masterKeyRef, two.masterKeyRef,
    'two masters share a reference, so a rotation would be untraceable');
  const { wrapped } = await one.generateDataKey(seed.a.tenantId);
  await assert.rejects(() => two.unwrapDataKey(seed.a.tenantId, wrapped));
});

test('the interface refuses to be used unimplemented', async () => {
  const bare = new keyProviderMod.KeyProvider();
  assert.throws(() => bare.name, /not implemented/);
  await assert.rejects(() => bare.generateDataKey('x'), /not implemented/);
  await assert.rejects(() => bare.unwrapDataKey('x', Buffer.alloc(0)), /not implemented/);
});

test('an unknown provider name is refused rather than defaulted', () => {
  assert.throws(() => keyProviderMod.createKeyProvider({ KEY_PROVIDER: 'rot13' }),
    /unknown KEY_PROVIDER/);
});

test('aws-kms without a key id refuses to start', () => {
  assert.throws(() => keyProviderMod.createKeyProvider({ KEY_PROVIDER: 'aws-kms' }),
    /KMS_KEY_ID is required/);
});

/**
 * Run a snippet in a real production-configured process.
 *
 * `config.isProd` is fixed when the module loads, so this cannot be faked by
 * assigning to process.env mid-suite — and faking it would test the fake. A
 * child process with NODE_ENV=production is the only honest way to ask what
 * happens in production.
 */
function inProduction(snippet) {
  const out = execFileSync(process.execPath, ['-e', snippet], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://app.example.com',
      SESSION_SIGNING_SECRET: 'x'.repeat(48),
      SSO_PROVIDER: 'workos',
      WORKOS_API_KEY: 'sk_test',
      WORKOS_CLIENT_ID: 'client_test',
      KEY_PROVIDER: '',
      KMS_KEY_ID: '',
    },
    encoding: 'utf8',
  });
  return out.trim();
}

test('KEY_PROVIDER=local is impossible to select in production', () => {
  // Exactly what config.js does with SSO_PROVIDER=stub, and for the same
  // reason: a master key derived from an environment variable lives in a
  // process listing, a task definition and a memory dump. Shipping it would
  // make the encryption claim false while every test still passed.
  const result = inProduction(`
    const { createKeyProvider } = require('./src/crypto/keyProvider');
    try { createKeyProvider({ KEY_PROVIDER: 'local' }); console.log('ACCEPTED'); }
    catch (e) { console.log('REFUSED: ' + e.message); }
  `);
  assert.match(result, /^REFUSED: KEY_PROVIDER=local .* never run in production$/);
});

test('production with no KEY_PROVIDER set reaches for KMS, never the local one', () => {
  // The default follows the environment, so there is no mode to forget to set.
  const result = inProduction(`
    const { createKeyProvider } = require('./src/crypto/keyProvider');
    try { createKeyProvider({}); console.log('ACCEPTED'); }
    catch (e) { console.log('REFUSED: ' + e.message); }
  `);
  assert.match(result, /^REFUSED: KMS_KEY_ID is required/);
});

test('outside production the local provider is the default', () => {
  const p = keyProviderMod.createKeyProvider({});
  assert.equal(p.name, 'local');
});

// ─── What is actually on disk ────────────────────────────────────────────────

test('a deal written through the API leaves NO plaintext in the database', async () => {
  // The claim the whole feature is sold on, checked by reading the raw columns
  // as the table owner — the position of someone holding a stolen credential.
  const x = await signIn('org_x', 'analyst@firmx.com');
  const secret = 'SellerIsMotivatedAndWillTakeSevenPointTwoFive';
  const created = await x.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Encrypted Tower', payload: { note: secret, purchasePrice: 9_250_000 } }),
  });
  assert.equal(created.status, 201);
  const { deal } = await created.json();

  const raw = await ownerQuery(
    'SELECT payload, payload_ct FROM deals WHERE id = $1', [deal.id]);
  assert.equal(raw.rows[0].payload, null, 'the plaintext jsonb column still holds the payload');
  assert.ok(Buffer.isBuffer(raw.rows[0].payload_ct), 'no ciphertext was stored');
  assert.ok(!raw.rows[0].payload_ct.toString('latin1').includes(secret),
    'the deal terms are readable in the ciphertext column');
  assert.ok(!raw.rows[0].payload_ct.toString('latin1').includes('9250000'));

  // And it still reads back as the model the analyst entered.
  const back = await (await x.call(`/api/deals/${deal.id}`)).json();
  assert.equal(back.deal.payload.note, secret);
  assert.equal(back.deal.payload.purchasePrice, 9_250_000);
  assert.ok(!('payload_ct' in back.deal), 'the ciphertext column leaked into the response');
});

test('a whole-table dump contains no deal terms in the clear', async () => {
  // The broader version: not "this row", but every row the application wrote.
  const x = await signIn('org_x', 'analyst@firmx.com');
  await x.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Second Tower', payload: { exitCapRate: 0.0625, sponsor: 'Redacted Partners' } }),
  });
  const dump = await ownerQuery(
    'SELECT payload::text AS p FROM deals WHERE payload IS NOT NULL');
  for (const row of dump.rows) {
    assert.ok(!row.p.includes('Redacted Partners'), 'a payload written by the API is in the clear');
    assert.ok(!row.p.includes('0.0625'));
  }
});

test('the tenant key row holds a WRAPPED key, never a usable one', async () => {
  const rows = await ownerQuery(
    'SELECT provider, master_key_ref, wrapped_key, destroyed_at FROM tenant_keys WHERE tenant_id = $1',
    [seed.a.tenantId]);
  assert.equal(rows.rows.length, 1, 'no key was provisioned for the tenant');
  assert.equal(rows.rows[0].provider, 'local');
  assert.match(rows.rows[0].master_key_ref, /^local:[0-9a-f]{16}$/);
  assert.equal(rows.rows[0].destroyed_at, null);
  // A wrapped AES-256 key is 32 bytes of key plus the envelope's own header and
  // tag, so a row holding exactly 32 bytes would be a raw key.
  assert.ok(rows.rows[0].wrapped_key.length > 32, 'the stored key is not wrapped');
});

test('a ciphertext moved from one firm\'s row into another\'s does not decrypt', async () => {
  // THE ATTACK, end to end and through the real read path: someone with
  // database access copies Firm X's sealed payload into a Firm Y deal, hoping
  // it will be served to them under their own session.
  //
  // MUTATION-VERIFIED, AND NOT THE WAY I FIRST WROTE IT. This test stays GREEN
  // when the tenant id is removed from the additional authenticated data,
  // because the two firms hold different data keys and the decryption fails on
  // the key rather than on the tag. So it proves the OUTCOME — no cross-tenant
  // read — and not the mechanism. The two tests that actually catch an unbound
  // AAD are 'a blob sealed for one tenant cannot be opened as another' and 'a
  // wrapped key cannot be unwrapped for a different tenant'; deleting the
  // binding turns exactly those red. The AAD is what covers the case this test
  // cannot construct: any future in which two tenants share key material.
  const x = await signIn('org_x', 'analyst@firmx.com');
  const y = await signIn('org_y', 'analyst@firmy.com');

  const mine = await (await x.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Firm X Confidential', payload: { irr: 0.211, lender: 'Bank of X' } }),
  })).json();
  const theirs = await (await y.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Firm Y Ordinary', payload: { irr: 0.1 } }),
  })).json();

  const stolen = (await ownerQuery('SELECT payload_ct FROM deals WHERE id = $1',
    [mine.deal.id])).rows[0].payload_ct;
  await ownerQuery('UPDATE deals SET payload = NULL, payload_ct = $2 WHERE id = $1',
    [theirs.deal.id, stolen]);

  const read = await (await y.call(`/api/deals/${theirs.deal.id}`)).json();
  assert.equal(read.deal.payload, null, 'a foreign ciphertext decrypted into this tenant');
  assert.equal(read.deal.payloadError, 'decrypt_failed');
  // And nothing resembling the blob was handed over in its place.
  const body = JSON.stringify(read);
  assert.ok(!body.includes('Bank of X'));
  assert.ok(!/[A-Za-z0-9+/]{120,}={0,2}/.test(body), 'ciphertext was served as if it were a payload');
});

// ─── The transition ──────────────────────────────────────────────────────────

test('a pre-encryption plaintext row is still readable through the API', async () => {
  // Migration 005 does not rewrite existing rows, so a deploy must serve both
  // shapes. The two deals seeded by the fixture were written as plaintext.
  const x = await signIn('org_x', 'analyst@firmx.com');
  const legacy = await (await x.call(`/api/deals/${seed.a.dealId}`)).json();
  assert.equal(legacy.deal.payload.purchasePrice, 1_000_000);
  assert.ok(!legacy.deal.payloadError);

  const raw = await ownerQuery('SELECT payload, payload_ct FROM deals WHERE id = $1',
    [seed.a.dealId]);
  assert.ok(raw.rows[0].payload, 'the fixture row is not the plaintext shape this test needs');
  assert.equal(raw.rows[0].payload_ct, null);
});

test('a row can never hold both shapes at once', async () => {
  // Without this constraint a half-finished backfill leaves the cleartext
  // sitting beside the ciphertext, and the encryption claim is false for rows
  // nobody can distinguish from the rest. Run against a throwaway row: the
  // assertions below would otherwise leave the fixture in whichever state the
  // last statement managed, and a later test would be reading it.
  const tmp = (await ownerQuery(
    `INSERT INTO deals (tenant_id, name, payload) VALUES ($1,'constraint probe','{"a":1}')
     RETURNING id`, [seed.a.tenantId])).rows[0].id;
  try {
    await assert.rejects(
      () => ownerQuery(`UPDATE deals SET payload_ct = '\\x00'::bytea WHERE id = $1`, [tmp]),
      /deals_payload_exactly_one_shape|check constraint/i,
      'a row was allowed to hold the plaintext and the ciphertext at once',
    );
    await assert.rejects(
      () => ownerQuery('UPDATE deals SET payload = NULL WHERE id = $1', [tmp]),
      /deals_payload_exactly_one_shape|check constraint/i,
      'a row was allowed to hold neither shape',
    );
  } finally {
    await ownerQuery('DELETE FROM deals WHERE id = $1', [tmp]);
  }
});

test('the backfill is a DRY RUN unless told otherwise', async () => {
  const before = await ownerQuery(
    'SELECT count(*)::int AS n FROM deals WHERE payload IS NOT NULL');
  assert.ok(before.rows[0].n > 0, 'nothing is left to convert, so this proves nothing');

  const report = await backfillMod.backfill({ log: () => {} });
  assert.equal(report.apply, false);
  assert.ok(report.tenants.some((t) => t.plaintext > 0 && t.dryRun === true));
  assert.ok(report.tenants.every((t) => t.converted === 0));

  const after = await ownerQuery(
    'SELECT count(*)::int AS n FROM deals WHERE payload IS NOT NULL');
  assert.equal(after.rows[0].n, before.rows[0].n, 'a dry run converted rows');
});

test('the backfill converts every plaintext row, once, and records it', async () => {
  const report = await backfillMod.backfill({ apply: true, log: () => {} });
  assert.ok(report.tenants.reduce((n, t) => n + t.converted, 0) > 0);

  const left = await ownerQuery(
    'SELECT count(*)::int AS n FROM deals WHERE payload IS NOT NULL');
  assert.equal(left.rows[0].n, 0, 'plaintext payloads survived the backfill');

  // Still readable, which is the only thing that makes the conversion safe.
  const x = await signIn('org_x', 'analyst@firmx.com');
  const legacy = await (await x.call(`/api/deals/${seed.a.dealId}`)).json();
  assert.equal(legacy.deal.payload.purchasePrice, 1_000_000);
  assert.ok(!legacy.deal.payloadError);

  const audited = await ownerQuery(
    "SELECT tenant_id, detail FROM audit_log WHERE action = 'tenant.payloads_encrypted'");
  assert.ok(audited.rows.length >= 1);
  assert.ok(audited.rows.some((r) => r.detail.converted > 0));

  // Re-running finds nothing, rather than double-encrypting.
  const again = await backfillMod.backfill({ apply: true, log: () => {} });
  assert.equal(again.tenants.reduce((n, t) => n + t.converted, 0), 0);
});

test('a payload that cannot be read is null with a reason, never an empty object', async () => {
  // The house rule, at the one place it would be tempting to break: an
  // unreadable model rendered as `{}` is a claim that the deal has no
  // assumptions, which is a different and far more dangerous statement than
  // "this could not be read".
  const x = await signIn('org_x', 'analyst@firmx.com');
  const d = await (await x.call('/api/deals', {
    method: 'POST', body: JSON.stringify({ name: 'Doomed', payload: { a: 1 } }),
  })).json();

  await ownerQuery(
    "UPDATE deals SET payload_ct = decode('01' || repeat('00', 40), 'hex') WHERE id = $1",
    [d.deal.id]);
  const read = await (await x.call(`/api/deals/${d.deal.id}`)).json();
  assert.equal(read.deal.payload, null);
  assert.equal(read.deal.payloadError, 'decrypt_failed');
  assert.notDeepEqual(read.deal.payload, {});
});

test('the application cannot destroy or repoint a tenant key', async () => {
  // Crypto-shredding is irreversible, so it is an operator action holding the
  // owner credential — never something a request path can reach.
  await assert.rejects(
    () => pool.withTenant(seed.a.tenantId, null, (db) => db.query(
      'UPDATE tenant_keys SET wrapped_key = NULL, destroyed_at = now() WHERE tenant_id = $1',
      [seed.a.tenantId])),
    /permission denied/i,
  );
  await assert.rejects(
    () => pool.withTenant(seed.a.tenantId, null, (db) => db.query(
      'DELETE FROM tenant_keys WHERE tenant_id = $1', [seed.a.tenantId])),
    /permission denied/i,
  );
});

test('one firm cannot read another firm\'s key row', async () => {
  const seen = await pool.withTenant(seed.b.tenantId, null, (db) => db.query(
    'SELECT tenant_id FROM tenant_keys').then((q) => q.rows));
  for (const row of seen) {
    assert.equal(row.tenant_id, seed.b.tenantId, 'tenant_keys leaked a foreign row');
  }
});

test('a destroyed key stops working immediately, not when a cache expires', async () => {
  // The cache is keyed by a digest of the WRAPPED blob and the row is still
  // read on every call, so destruction takes effect on the next request. Keyed
  // by tenant id instead, a warm process would keep serving the destroyed key
  // for the whole TTL and the erasure claim would be false for that long.
  const t = (await ownerQuery(
    'INSERT INTO tenants (slug, name, broker_org_id) VALUES ($1,$2,$3) RETURNING id',
    ['firm-shred', 'Firm Shred', 'org_shred'])).rows[0].id;

  const ct = await pool.withTenant(t, null, (db) => keyring.sealPayload(db, t, { a: 1 }));
  assert.deepEqual(
    await pool.withTenant(t, null, (db) => keyring.openPayload(db, t, { payload_ct: ct })),
    { payload: { a: 1 } });

  await ownerQuery(
    'UPDATE tenant_keys SET wrapped_key = NULL, destroyed_at = now() WHERE tenant_id = $1', [t]);

  assert.deepEqual(
    await pool.withTenant(t, null, (db) => keyring.openPayload(db, t, { payload_ct: ct })),
    { payload: null, payloadError: 'key_destroyed' });
});

test('two first writes for a brand-new firm both succeed', async () => {
  // The key is created lazily on a tenant's first write, so two requests
  // arriving together both find no key. The race is CONSTRUCTED here rather
  // than hoped for: two connections are driven by hand so that the second
  // reaches its key lookup while the first still holds an open transaction.
  // Left to Promise.all, the two happen to serialise and the test passes with
  // or without the lock — which is a test that proves nothing. Verified by
  // mutation: remove the advisory lock from tenantDataKey and the second
  // transaction dies on the primary key, losing a new firm's first save to a
  // race that happens once per customer and is therefore never seen in
  // development.
  const t = (await ownerQuery(
    'INSERT INTO tenants (slug, name, broker_org_id) VALUES ($1,$2,$3) RETURNING id',
    ['firm-race', 'Firm Race', 'org_race'])).rows[0].id;

  const open = async () => {
    const c = new Client({ connectionString: env.appUrl });
    await c.connect();
    await c.query('BEGIN');
    await c.query('SELECT set_config($1,$2,true)', ['app.current_tenant', t]);
    return c;
  };
  const first = await open();
  const second = await open();

  try {
    const firstKey = await keyring.tenantDataKey(first, t);

    // The second transaction now asks for the same key while the first is
    // still uncommitted, and must BLOCK rather than race ahead.
    const pending = keyring.tenantDataKey(second, t);
    let blocked = false;
    for (let i = 0; i < 60 && !blocked; i += 1) {
      const waiting = await ownerQuery(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'");
      blocked = waiting.rows[0].n > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(blocked, 'the second writer never blocked, so the race was not constructed');

    await first.query('COMMIT');
    const secondKey = await pending;

    // The same key, not a second one. Two keys would leave one of the two
    // payloads permanently unreadable.
    assert.ok(secondKey.equals(firstKey), 'the two writers minted different keys');
    await second.query('COMMIT');
    assert.equal(
      (await ownerQuery('SELECT count(*)::int AS n FROM tenant_keys WHERE tenant_id = $1', [t])).rows[0].n,
      1);
  } finally {
    await first.query('ROLLBACK').catch(() => {});
    await second.query('ROLLBACK').catch(() => {});
    await first.end().catch(() => {});
    await second.end().catch(() => {});
  }
});
