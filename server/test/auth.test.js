'use strict';

/**
 * The login flow, attacked.
 *
 * Each test is a specific attack, not a happy path with an assertion bolted on.
 * The happy path is one test; the other eleven are the ways in.
 */

const test = require('node:test');
const assert = require('node:assert');
const { freshDatabase, seedTwoTenants } = require('./helpers');

process.env.SSO_PROVIDER = 'stub';

let env, seed, login, brokerMod, stub, pool, server, base;

test.before(async () => {
  env = await freshDatabase('auth');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.APP_ORIGIN = 'http://localhost:3000';
  // Required after DATABASE_URL is set: config and pool capture it on load.
  login = require('../src/auth/login');
  brokerMod = require('../src/auth/broker');
  pool = require('../src/db/pool');
  stub = brokerMod.broker();
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

function cookies(res) {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]);
}

async function browserLogin() {
  const start = await fetch(`${base}/auth/start?org=firm-x&next=/pipeline`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const provider = new URL(start.headers.get('location'));
  const state = provider.searchParams.get('state');
  const code = provider.searchParams.get('code');
  stub.__setProfile(code, goodProfile());
  return { start, state, cookie: cookies(start)[0],
    callback: `${base}/auth/callback?state=${state}&code=${code}` };
}

const callback = (url, cookie) => fetch(url, {
  redirect: 'manual', headers: cookie ? { cookie } : {},
});

test('HTTP SSO sets a browser cookie and completes only in that browser', async () => {
  const begun = await browserLogin();
  const header = begun.start.headers.getSetCookie()[0];
  assert.match(header, /^cre_sso_state=[A-Za-z0-9_-]{43};/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.match(header, new RegExp(`Max-Age=${Math.floor(require('../src/config').sso.stateTtlMs / 1000)}(?:;|$)`));
  const res = await callback(begun.callback, begun.cookie);
  assert.equal(res.headers.get('location'), 'http://localhost:3000/pipeline');
  assert.ok(cookies(res).some((c) => /^cre_session=.+/.test(c)));
  assert.ok(res.headers.getSetCookie().some((c) => /^cre_sso_state=;/.test(c) && /Max-Age=0/.test(c)));
});

test('HTTP SSO rejects foreign browsers before consuming state or exchanging the code', async () => {
  const begun = await browserLogin();
  const other = await browserLogin();
  const exchange = stub.exchange;
  let exchanges = 0;
  stub.exchange = async (...args) => { exchanges += 1; return exchange(...args); };
  try {
    for (const cookie of [undefined, other.cookie, 'cre_sso_state=malformed', 'cre_sso_state=%E0%A4%A']) {
      const res = await callback(`${begun.callback}&browserState=${begun.state}`, cookie);
      assert.match(res.headers.get('location'), /\/signin\?error=bad_state$/);
      assert.ok(!cookies(res).some((c) => /^cre_session=/.test(c)));
      assert.ok(res.headers.getSetCookie().some((c) => /^cre_sso_state=;/.test(c) && /Max-Age=0/.test(c)));
    }
    assert.equal(exchanges, 0, 'a refused browser reached the provider exchange');
    const good = await callback(begun.callback, begun.cookie);
    assert.equal(good.headers.get('location'), 'http://localhost:3000/pipeline');
    assert.equal(exchanges, 1, 'the legitimate browser could not finish');
  } finally { stub.exchange = exchange; }
});

test('HTTP SSO rejects absent and ambiguous URL state even with a browser cookie', async () => {
  const begun = await browserLogin();
  for (const url of [begun.callback.replace(`state=${begun.state}&`, ''),
    `${begun.callback}&state=${begun.state}`]) {
    const res = await callback(url, begun.cookie);
    assert.match(res.headers.get('location'), /\/signin\?error=bad_state$/);
    assert.ok(!cookies(res).some((c) => /^cre_session=/.test(c)));
  }
});

test('HTTP SSO replay fails even when the original browser cookie is restored', async () => {
  const begun = await browserLogin();
  const first = await callback(begun.callback, begun.cookie);
  assert.ok(cookies(first).some((c) => /^cre_session=.+/.test(c)));
  for (const cookie of [undefined, begun.cookie]) {
    const replay = await callback(begun.callback, cookie);
    assert.match(replay.headers.get('location'), /\/signin\?error=bad_state$/);
    assert.ok(!cookies(replay).some((c) => /^cre_session=/.test(c)));
  }
});

test('HTTP SSO atomically rejects concurrent callback replay', async () => {
  const begun = await browserLogin();
  const responses = await Promise.all([
    callback(begun.callback, begun.cookie), callback(begun.callback, begun.cookie),
  ]);
  assert.equal(responses.filter((res) => cookies(res).some((c) => /^cre_session=.+/.test(c))).length, 1);
  assert.equal(responses.filter((res) => /error=bad_state$/.test(res.headers.get('location'))).length, 1);
});

test('HTTP SSO clears browser state when server state expires or the provider exchange fails', async () => {
  const expired = await browserLogin();
  await pool.authPool.query(
    "UPDATE sso_states SET expires_at = now() - interval '1 minute' WHERE state = $1", [expired.state]);
  const begun = await browserLogin();
  const exchange = stub.exchange;
  try {
    stub.exchange = async () => { throw Object.assign(new Error('provider unavailable'), { status: 502 }); };
    for (const [attempt, expected] of [[expired, 302], [begun, 502]]) {
      const res = await callback(attempt.callback, attempt.cookie);
      assert.equal(res.status, expected);
      assert.ok(res.headers.getSetCookie().some((c) => /^cre_sso_state=;/.test(c) && /Max-Age=0/.test(c)));
      assert.ok(!cookies(res).some((c) => /^cre_session=/.test(c)));
    }
  } finally { stub.exchange = exchange; }
});

test('a WorkOS callback completes through the browser state check and real broker parser', async () => {
  const config = require('../src/config');
  const originalProvider = config.sso.provider;
  const originalWorkos = config.sso.workos;
  const realFetch = global.fetch;
  const exchanges = [];
  config.sso.provider = 'workos';
  config.sso.workos = { ...originalWorkos, apiKey: 'sk_test', clientId: 'client_test',
    redirectUri: `${base}/auth/callback` };
  brokerMod.__reset();
  global.fetch = async (url, init) => {
    if (String(url) !== 'https://api.workos.com/sso/token') return realFetch(url, init);
    exchanges.push(new URLSearchParams(init.body).get('code'));
    return { ok: true, status: 200, json: async () => ({ profile: {
      organization_id: 'org_x', email: 'analyst@firmx.com', id: 'profile_test',
      connection_id: 'conn_test', connection_type: 'OktaSAML',
    } }) };
  };
  try {
    const start = await fetch(`${base}/auth/start?org=firm-x&next=/pipeline`, { redirect: 'manual' });
    const url = new URL(start.headers.get('location'));
    assert.equal(url.origin + url.pathname, 'https://api.workos.com/sso/authorize');
    assert.equal(url.searchParams.get('organization'), 'org_x');
    const callbackUrl = `${base}/auth/callback?state=${url.searchParams.get('state')}&code=workos_code`;
    const foreign = await callback(callbackUrl);
    assert.match(foreign.headers.get('location'), /error=bad_state$/);
    assert.deepEqual(exchanges, []);
    const good = await callback(callbackUrl, cookies(start)[0]);
    assert.equal(good.headers.get('location'), 'http://localhost:3000/pipeline');
    assert.ok(cookies(good).some((c) => /^cre_session=.+/.test(c)));
    assert.deepEqual(exchanges, ['workos_code']);
  } finally {
    global.fetch = realFetch;
    config.sso.provider = originalProvider;
    config.sso.workos = originalWorkos;
    brokerMod.__reset();
    stub = brokerMod.broker();
  }
});

test('production SSO uses a Secure host-prefixed cookie and ignores the development cookie', async () => {
  const config = require('../src/config');
  const wasProd = config.isProd;
  config.isProd = true;
  try {
    const begun = await browserLogin();
    const header = begun.start.headers.getSetCookie()[0];
    assert.match(header, /^__Host-cre_sso_state=/);
    assert.match(header, /; Secure(?:;|$)/);
    assert.match(header, /; Path=\/(?:;|$)/);
    assert.ok(!/; Domain=/i.test(header));
    const bad = await callback(begun.callback, begun.cookie.replace('__Host-', ''));
    assert.match(bad.headers.get('location'), /error=bad_state$/);
    const good = await callback(begun.callback, begun.cookie);
    assert.ok(cookies(good).some((c) => /^cre_session=.+/.test(c)));
    assert.ok(good.headers.getSetCookie().some((c) => /^__Host-cre_sso_state=;/.test(c) && /Max-Age=0/.test(c)));
  } finally { config.isProd = wasProd; }
});

/** Drive a full handshake, staging whatever the fake IdP should assert. */
async function handshake(profile, { tenantHint } = {}) {
  const begun = await login.begin({ tenantHint, redirectTo: '/pipeline' });
  const code = new URL(begun.url).searchParams.get('code');
  stub.__setProfile(code, profile);
  return login.complete({ state: begun.state, code, ip: '203.0.113.10', userAgent: 'test' });
}

const goodProfile = (over = {}) => ({
  organizationId: 'org_x',
  email: 'analyst@firmx.com',
  emailVerified: true,
  externalId: 'idp|1',
  name: 'An Analyst',
  connectionId: 'conn_1',
  idpName: 'OktaSAML',
  ...over,
});

test('a valid handshake issues a session in the asserted tenant', async () => {
  const r = await handshake(goodProfile(), { tenantHint: 'firm-x' });
  assert.equal(r.tenant.id, seed.a.tenantId);
  assert.equal(r.user.email, 'analyst@firmx.com');
  assert.ok(r.token && r.token.length > 30);
  assert.equal(r.redirectTo, '/pipeline');
});

test('the tenant comes from the ASSERTION, not the hint the client supplied', async () => {
  // The attack: an authenticated user of Firm X asks to be logged into Firm Y
  // by changing the org on the login URL. The hint only chooses an IdP; the
  // organization on the returned profile decides the tenant. If this ever
  // fails, the whole product is one query string away from a data breach.
  const r = await handshake(goodProfile({ organizationId: 'org_x' }), { tenantHint: 'firm-y' });
  assert.equal(r.tenant.id, seed.a.tenantId, 'the client-supplied hint changed the tenant');
  assert.notEqual(r.tenant.id, seed.b.tenantId);
});

test('a replayed state is refused', async () => {
  const begun = await login.begin({ redirectTo: '/' });
  const code = new URL(begun.url).searchParams.get('code');
  stub.__setProfile(code, goodProfile());
  await login.complete({ state: begun.state, code, ip: '1.2.3.4' });

  // Same state a second time. A real IdP callback can be captured from a
  // referer header, a shared screen or browser history.
  const code2 = new URL((await login.begin({})).url).searchParams.get('code');
  stub.__setProfile(code2, goodProfile());
  await assert.rejects(
    () => login.complete({ state: begun.state, code: code2 }),
    (e) => e.code === 'bad_state',
  );
});

test('an unknown or absent state is refused', async () => {
  for (const state of [undefined, null, '', 'made-up', 'a'.repeat(64)]) {
    await assert.rejects(
      () => login.complete({ state, code: 'whatever' }),
      (e) => e.code === 'bad_state',
      `state ${JSON.stringify(state)} was accepted`,
    );
  }
});

test('an expired state is refused', async () => {
  const begun = await login.begin({});
  const code = new URL(begun.url).searchParams.get('code');
  stub.__setProfile(code, goodProfile());
  await pool.unscoped().query(
    "UPDATE sso_states SET expires_at = now() - interval '1 minute' WHERE state = $1",
    [begun.state],
  );
  await assert.rejects(() => login.complete({ state: begun.state, code }),
    (e) => e.code === 'bad_state');
});

test('an organization with no provisioned tenant is refused', async () => {
  // No auto-created tenants: a login must not be able to conjure a tenant in a
  // product sold on the promise that firms are separated.
  await assert.rejects(
    () => handshake(goodProfile({ organizationId: 'org_never_onboarded' })),
    (e) => e.code === 'unknown_org' && e.status === 403,
  );
});

test('an unverified email is refused', async () => {
  await assert.rejects(
    () => handshake(goodProfile({ emailVerified: false })),
    (e) => e.code === 'unverified_email',
  );
});

test('an email whose domain is not verified for the tenant is refused', async () => {
  // The backstop against a misconfigured SSO connection. Firm X's connection
  // asserting a firmy.com address must not put that address inside Firm X.
  await assert.rejects(
    () => handshake(goodProfile({ email: 'someone@firmy.com' })),
    (e) => e.code === 'domain_not_verified' && e.status === 403,
  );
  await assert.rejects(
    () => handshake(goodProfile({ email: 'attacker@gmail.com' })),
    (e) => e.code === 'domain_not_verified',
  );
});

test('a lookalike domain does not satisfy the domain check', async () => {
  for (const email of [
    'a@firmx.com.evil.com', 'a@notfirmx.com', 'a@firmx.co', 'a@sub.firmx.com',
  ]) {
    await assert.rejects(
      () => handshake(goodProfile({ email })),
      (e) => e.code === 'domain_not_verified',
      `${email} passed the domain check`,
    );
  }
});

test('the email domain is matched case-insensitively, and the address normalised', async () => {
  const r = await handshake(goodProfile({ email: '  Analyst@FirmX.COM  ' }));
  assert.equal(r.user.email, 'analyst@firmx.com');
  assert.equal(r.tenant.id, seed.a.tenantId);
});

test('a suspended tenant cannot log in', async () => {
  // Suspending is a PLATFORM operation, so it runs on the owner connection.
  // Attempting it through the app's pool fails with "permission denied for
  // table tenants" — which is the grant in 001_tenancy.sql doing its job, and
  // is asserted directly in isolation.test.js. This test needed the platform
  // role; it is not a route the application exposes.
  const { Client } = require('pg');
  const owner = new Client({ connectionString: env.ownerUrl });
  await owner.connect();
  const setStatus = (s) => owner.query('UPDATE tenants SET status = $1 WHERE id = $2', [s, seed.b.tenantId]);
  try {
    await setStatus('suspended');
    await assert.rejects(
      () => handshake(goodProfile({ organizationId: 'org_y', email: 'analyst@firmy.com' })),
      (e) => e.code === 'tenant_suspended' && e.status === 403,
    );
  } finally {
    await setStatus('active');
    await owner.end();
  }
});

test('redirectTo cannot be turned into an open redirect', async () => {
  for (const bad of [
    'https://evil.example/steal', '//evil.example', 'javascript:alert(1)', 'http://evil',
  ]) {
    const r = await handshake(goodProfile(), { });
    assert.ok(r.redirectTo.startsWith('/'), 'a relative redirect is required');

    const begun = await login.begin({ redirectTo: bad });
    const row = await pool.unscoped().query(
      'SELECT redirect_to FROM sso_states WHERE state = $1', [begun.state],
    );
    assert.equal(row.rows[0].redirect_to, '/', `${bad} survived as a redirect target`);
  }
});

test('JIT provisioning creates the user once and does not re-bind the IdP subject', async () => {
  const first = await handshake(goodProfile({ email: 'newjoiner@firmx.com', externalId: 'idp|new' }));
  const second = await handshake(goodProfile({ email: 'newjoiner@firmx.com', externalId: 'idp|DIFFERENT' }));
  assert.equal(first.user.id, second.user.id, 'a second login created a duplicate user');

  const row = await pool.withTenant(seed.a.tenantId, null, (db) =>
    db.query('SELECT external_id FROM users WHERE email = $1', ['newjoiner@firmx.com'])
      .then((q) => q.rows[0]));
  // A changed subject for a known address means the directory was
  // reconfigured. Silently re-binding would hand the account to whoever holds
  // the address now.
  assert.equal(row.external_id, 'idp|new');
});

test('the login is recorded in the audit log, without the full address', async () => {
  await handshake(goodProfile());
  const rows = await pool.withTenant(seed.a.tenantId, null, (db) =>
    db.query("SELECT action, detail FROM audit_log WHERE action = 'auth.login' ORDER BY at DESC LIMIT 1")
      .then((q) => q.rows));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail.domain, 'firmx.com');
  assert.equal(rows[0].detail.idp, 'OktaSAML');
  assert.ok(!JSON.stringify(rows[0].detail).includes('analyst@'), 'the audit detail duplicated the address');
});

test('a session token is stored only as a hash', async () => {
  const r = await handshake(goodProfile());
  // Via the AUTH pool: app_user has no grant on sessions since migration 002,
  // which isolation.test.js asserts directly.
  const q = await pool.authPool.query('SELECT token_hash FROM sessions');
  for (const row of q.rows) {
    assert.ok(Buffer.isBuffer(row.token_hash));
    assert.ok(!row.token_hash.toString('utf8').includes(r.token), 'the raw token was stored');
  }
  const direct = await pool.authPool.query(
    'SELECT 1 FROM sessions WHERE token_hash::text LIKE $1', [`%${r.token}%`],
  );
  assert.equal(direct.rows.length, 0);
});
