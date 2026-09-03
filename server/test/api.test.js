'use strict';

/**
 * The API over real HTTP, with two tenants signed in at once.
 *
 * isolation.test.js proves the database boundary and auth.test.js proves the
 * handshake. This file proves the thing a customer actually cares about: that
 * two firms using the product simultaneously cannot reach each other's deals
 * through the routes as they are actually wired — session, middleware, CSRF,
 * role gate and all.
 */

const test = require('node:test');
const assert = require('node:assert');
const { freshDatabase, seedTwoTenants } = require('./helpers');

process.env.SSO_PROVIDER = 'stub';

let env, seed, server, base, login, brokerMod, stub, pool;

test.before(async () => {
  env = await freshDatabase('api');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.APP_ORIGIN = 'http://localhost:3000';
  login = require('../src/auth/login');
  brokerMod = require('../src/auth/broker');
  pool = require('../src/db/pool');
  stub = brokerMod.broker();
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
  const me = await fetch(`${base}/auth/me`, { headers: { cookie } });
  const body = await me.json();

  const call = (path, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      ...(init.method && !['GET', 'HEAD'].includes(init.method)
        ? { 'x-csrf-token': body.csrfToken } : {}),
      ...(init.headers || {}),
    },
  });
  return { cookie, csrf: body.csrfToken, me: body, call };
}

async function promote(tenantId, email, role) {
  await pool.withTenant(tenantId, null, (db) =>
    db.query('UPDATE users SET role = $1 WHERE email = $2', [role, email]));
}

test('an unauthenticated request is refused', async () => {
  const r = await fetch(`${base}/api/deals`);
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'unauthenticated' });
});

test('a forged session cookie is refused', async () => {
  for (const token of ['', 'x', 'a'.repeat(43), 'null', '../../etc/passwd']) {
    const r = await fetch(`${base}/api/deals`, { headers: { cookie: `cre_session=${encodeURIComponent(token)}` } });
    assert.equal(r.status, 401, `token ${JSON.stringify(token)} was accepted`);
  }
});

test('each firm sees only its own deals through the API', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const y = await signIn('org_y', 'analyst@firmy.com');

  const xDeals = await (await x.call('/api/deals')).json();
  const yDeals = await (await y.call('/api/deals')).json();
  assert.deepEqual(xDeals.deals.map((d) => d.name), ['Firm X Tower']);
  assert.deepEqual(yDeals.deals.map((d) => d.name), ['Firm Y Tower']);
});

test('fetching another firm\'s deal by id is a 404, not a 403', async () => {
  // 403 would confirm the id exists — that a competitor is working on
  // something. 404 says only "not yours to know about".
  const x = await signIn('org_x', 'analyst@firmx.com');
  const r = await x.call(`/api/deals/${seed.b.dealId}`);
  assert.equal(r.status, 404);
});

test('writing to another firm\'s deal is a 404 and changes nothing', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const r = await x.call(`/api/deals/${seed.b.dealId}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'hijacked', payload: {} }),
  });
  assert.equal(r.status, 404);

  const y = await signIn('org_y', 'analyst@firmy.com');
  const still = await (await y.call(`/api/deals/${seed.b.dealId}`)).json();
  assert.equal(still.deal.name, 'Firm Y Tower');
});

test('a deal created by one firm never appears for the other', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const created = await x.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Confidential Alpha', stage: 'IC Thursday', payload: { purchasePrice: 42 } }),
  });
  assert.equal(created.status, 201);
  const { deal } = await created.json();

  const y = await signIn('org_y', 'analyst@firmy.com');
  const list = await (await y.call('/api/deals')).json();
  assert.ok(!list.deals.some((d) => d.name === 'Confidential Alpha'));
  assert.equal((await y.call(`/api/deals/${deal.id}`)).status, 404);
});

test('a tenant id supplied in the body cannot redirect the write', async () => {
  // The naive multi-tenant bug: trusting a tenant field from the client. The
  // route never reads one, and the policy would reject it anyway.
  const x = await signIn('org_x', 'analyst@firmx.com');
  const r = await x.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Planted', payload: {},
      tenant_id: seed.b.tenantId, tenantId: seed.b.tenantId,
    }),
  });
  assert.equal(r.status, 201);
  const { deal } = await r.json();

  const y = await signIn('org_y', 'analyst@firmy.com');
  const list = await (await y.call('/api/deals')).json();
  assert.ok(!list.deals.some((d) => d.id === deal.id), 'a body field placed a row in another tenant');
});

test('a write without the CSRF token is refused', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const r = await fetch(`${base}/api/deals`, {
    method: 'POST',
    headers: { cookie: x.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'No CSRF', payload: {} }),
  });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'csrf' });
});

test('another session\'s CSRF token does not work', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const y = await signIn('org_y', 'analyst@firmy.com');
  const r = await fetch(`${base}/api/deals`, {
    method: 'POST',
    headers: {
      cookie: x.cookie, 'content-type': 'application/json',
      'x-csrf-token': y.csrf, origin: 'http://localhost:3000',
    },
    body: JSON.stringify({ name: 'Borrowed token', payload: {} }),
  });
  assert.equal(r.status, 403);
});

test('a cross-site origin is refused on a write', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const r = await fetch(`${base}/api/deals`, {
    method: 'POST',
    headers: {
      cookie: x.cookie, 'content-type': 'application/json',
      'x-csrf-token': x.csrf, origin: 'https://evil.example',
    },
    body: JSON.stringify({ name: 'Cross site', payload: {} }),
  });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'origin' });
});

test('an analyst cannot delete; a VP can', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const mk = await (await x.call('/api/deals', {
    method: 'POST', body: JSON.stringify({ name: 'To delete', payload: {} }),
  })).json();

  const denied = await x.call(`/api/deals/${mk.deal.id}`, { method: 'DELETE' });
  assert.equal(denied.status, 403);

  await promote(seed.a.tenantId, 'analyst@firmx.com', 'vp');
  const vp = await signIn('org_x', 'analyst@firmx.com');
  const ok = await vp.call(`/api/deals/${mk.deal.id}`, { method: 'DELETE' });
  assert.equal(ok.status, 204);
  await promote(seed.a.tenantId, 'analyst@firmx.com', 'analyst');
});

test('a revoked session stops working immediately', async () => {
  // Offboarding must take effect now, not when a token happens to expire.
  const x = await signIn('org_x', 'analyst@firmx.com');
  assert.equal((await x.call('/api/deals')).status, 200);
  const out = await x.call('/auth/logout', { method: 'POST' });
  assert.equal(out.status, 204);
  assert.equal((await x.call('/api/deals')).status, 401);
});

test('/auth/me reports the tenant and never a foreign one', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  assert.equal(x.me.tenant.slug, 'firm-x');
  assert.equal(x.me.user.email, 'analyst@firmx.com');
  assert.ok(x.me.csrfToken);
});

test('an oversized payload is refused rather than stored', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const r = await x.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Huge', payload: { blob: 'x'.repeat(600 * 1024) } }),
  });
  assert.ok([400, 413].includes(r.status), `expected a rejection, got ${r.status}`);
});

test('an error response never leaks a stack trace or SQL', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  // A malformed uuid reaches the driver as a cast error.
  const r = await x.call('/api/deals/not-a-uuid');
  const body = await r.text();
  assert.ok(!/at .*\.js:\d+/.test(body), 'a stack trace reached the client');
  assert.ok(!/select|invalid input syntax|pg_/i.test(body), `driver detail leaked: ${body}`);
});

test('the health endpoint is public and reveals nothing', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});
