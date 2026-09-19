'use strict';

/**
 * Duo as a second factor, end to end.
 *
 * Every test here drives the real login path against a real Postgres, with a
 * fake Duo standing in for the service. The fake is a real HTTP server speaking
 * the real protocol — signing its id_tokens with the real client secret — so
 * what is being exercised is the verification in src/auth/duo.js, not a mock of
 * it. A stubbed `exchange()` would pass every one of these while the signature
 * check was commented out.
 *
 * The tests are organised around the ways this integration can be wrong, in
 * rough order of how expensive each would be:
 *
 *   1. A session exists before the factor passes.
 *   2. Duo's answer is accepted for the wrong person.
 *   3. A forged or replayed id_token is accepted.
 *   4. A challenge is replayable, or usable from another browser.
 *   5. Fail-open admits someone Duo actively refused.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');

process.env.SSO_PROVIDER = 'stub';
// 32 bytes, base64. Without it no Duo configuration can be sealed at all.
process.env.DUO_CONFIG_KEY = crypto.randomBytes(32).toString('base64');

let env, seed, pool, login, mfa, duoMod, brokerMod, stub, fake, admin;

/** Duo's fixed credential sizes. The client refuses anything else. */
const CLIENT_ID = 'DIXXXXXXXXXXXXXXXXXX';
const CLIENT_SECRET = 'a'.repeat(40);
const API_HOST = 'api-deadbeef.duosecurity.com';

/**
 * A fake Duo.
 *
 * Answers the two endpoints that matter and signs its id_token with the same
 * HS512 the real service uses. `behaviour` is mutated per test so one server
 * can play healthy, unreachable, refusing, and malicious in turn.
 */
function startFakeDuo() {
  const state = {
    healthy: true,
    // What username the id_token claims. Defaults to whatever was asked for;
    // set it to impersonate someone.
    claimUsername: null,
    // Sign with the wrong key, to prove the signature is actually checked.
    signWith: null,
    claimOverrides: {},
    lastAuthorize: null,
  };

  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (input, secret) => crypto.createHmac('sha512', secret).update(input).digest('base64url');
  const jwt = (claims, secret) => {
    const h = b64u({ alg: 'HS512', typ: 'JWT' });
    const b = b64u(claims);
    return `${h}.${b}.${sign(`${h}.${b}`, secret)}`;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (url.pathname === '/oauth/v1/health_check') {
        if (!state.healthy) return send(200, { stat: 'FAIL', code: 40002, message: 'unhealthy' });
        return send(200, { stat: 'OK', response: { time: Date.now() } });
      }

      if (url.pathname === '/oauth/v1/token') {
        if (!state.healthy) return send(200, { stat: 'FAIL', code: 40002, message: 'unhealthy' });
        // The code carries the username the authorize step was given, so the
        // fake can answer about the right person without keeping state.
        const asked = Buffer.from(String(form.get('code') || ''), 'base64url').toString('utf8');
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: `https://${API_HOST}/oauth/v1/token`,
          aud: CLIENT_ID,
          iat: now,
          exp: now + 300,
          preferred_username: state.claimUsername ?? asked,
          auth_result: { result: 'allow', status: 'allow' },
          auth_device: { name: 'iPhone' },
          ...state.claimOverrides,
        };
        return send(200, { id_token: jwt(claims, state.signWith || CLIENT_SECRET) });
      }

      return send(404, { stat: 'FAIL', message: 'no such endpoint' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, state, port: server.address().port,
    }));
  });
}

/**
 * Point the Duo client at the fake.
 *
 * src/auth/duo.js validates api_host against Duo's real hostname pattern and
 * always speaks https, both deliberately — so the test redirects at the fetch
 * layer rather than weakening either check. The production code is exercised
 * exactly as written, hostname validation included.
 */
function redirectFetchToFake(port) {
  const real = global.fetch;
  global.fetch = (url, opts) => {
    const u = new URL(url);
    if (u.hostname === API_HOST) {
      return real(`http://127.0.0.1:${port}${u.pathname}${u.search}`, opts);
    }
    return real(url, opts);
  };
  return () => { global.fetch = real; };
}

let restoreFetch;

test.before(async () => {
  env = await freshDatabase('duo');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.DATABASE_MIGRATION_URL = env.migrationUrl;
  process.env.APP_ORIGIN = 'http://localhost:3000';
  process.env.DUO_REDIRECT_URI = 'http://localhost:8080/auth/duo/callback';

  pool = require('../src/db/pool');
  login = require('../src/auth/login');
  mfa = require('../src/auth/mfa');
  duoMod = require('../src/auth/duo');
  admin = require('../src/admin/duo');
  brokerMod = require('../src/auth/broker');
  stub = brokerMod.broker();

  fake = await startFakeDuo();
  restoreFetch = redirectFetchToFake(fake.port);
});

test.after(async () => {
  if (restoreFetch) restoreFetch();
  if (fake) await new Promise((r) => fake.server.close(r));
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

const ownerQuery = async (sql, params = []) => {
  const c = new Client({ connectionString: env.ownerUrl });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
};

/** Configure and enable Duo for firm X, bypassing the health-check gate. */
async function enableDuo({ failMode = 'closed' } = {}) {
  const sealed = mfa.sealSecret(seed.a.tenantId, CLIENT_SECRET);
  await ownerQuery(
    `INSERT INTO tenant_duo (tenant_id, api_host, client_id, client_secret_ct,
                             enabled, fail_mode, verified_at)
          VALUES ($1,$2,$3,$4,true,$5, now())
     ON CONFLICT (tenant_id) DO UPDATE
          SET enabled = true, fail_mode = EXCLUDED.fail_mode,
              client_secret_ct = EXCLUDED.client_secret_ct, verified_at = now()`,
    [seed.a.tenantId, API_HOST, CLIENT_ID, sealed, failMode]);
}

async function disableDuo() {
  await ownerQuery('UPDATE tenant_duo SET enabled = false WHERE tenant_id = $1',
    [seed.a.tenantId]);
}

/** Run a login as far as it will go, returning whatever complete() returns. */
async function signIn(over = {}) {
  const begun = await login.begin({ redirectTo: '/' });
  const code = `c-${crypto.randomUUID()}`;
  stub.__setProfile(code, {
    organizationId: 'org_x',
    email: `analyst@${seed.a.domain}`,
    emailVerified: true,
    externalId: 'stub|analyst',
    name: 'An Analyst',
    ...over,
  });
  return login.complete({
    state: begun.state, code, ip: '198.51.100.5', userAgent: 'test',
  });
}

/** Pull the state out of the Duo URL the challenge produced. */
const stateFrom = (url) => new URL(url).searchParams.get('state');

/**
 * The code the fake expects: the username it should answer about, base64url.
 * Stands in for a real Duo authorization code, which is opaque to us.
 */
const codeFor = (username) => Buffer.from(username, 'utf8').toString('base64url');

// ─── 1. No session before the factor ─────────────────────────────────────────

test('a Duo tenant gets a challenge, not a session', async () => {
  await enableDuo();
  const before = await ownerQuery('SELECT count(*)::int AS n FROM sessions');
  const result = await signIn();

  assert.equal(result.kind, 'mfa');
  assert.equal(result.token, undefined, 'a token was issued before the second factor');
  assert.ok(result.url.startsWith(`https://${API_HOST}/oauth/v1/authorize`), result.url);
  assert.ok(result.nonce && result.nonce.length >= 40);

  // THE invariant. Everything else in this file is in service of it.
  const after = await ownerQuery('SELECT count(*)::int AS n FROM sessions');
  assert.equal(after.rows[0].n, before.rows[0].n,
    'a session row exists before Duo has said anything');
});

test('a tenant without Duo is unaffected', async () => {
  await disableDuo();
  const result = await signIn();
  assert.equal(result.kind, 'session');
  assert.ok(result.token, 'a tenant with no Duo integration could not sign in');
  // The weaker claim, recorded as the weaker claim.
  const s = await ownerQuery(
    'SELECT mfa_factor FROM sessions ORDER BY issued_at DESC LIMIT 1');
  assert.equal(s.rows[0].mfa_factor, null);
});

test('a completed Duo login issues a session and records the factor', async () => {
  await enableDuo();
  const challenge = await signIn();
  const done = await login.completeDuo({
    state: stateFrom(challenge.url),
    nonce: challenge.nonce,
    code: codeFor(`analyst@${seed.a.domain}`),
    ip: '198.51.100.5',
  });

  assert.equal(done.kind, 'session');
  assert.ok(done.token);
  const s = await ownerQuery(
    'SELECT mfa_factor FROM sessions ORDER BY issued_at DESC LIMIT 1');
  // 'duo' means we challenged and verified. Distinct from 'idp', which means
  // somebody else's directory told us so.
  assert.equal(s.rows[0].mfa_factor, 'duo');
});

test('the login is audited once, when it actually happens', async () => {
  await enableDuo();
  const challenge = await signIn();
  const mid = await ownerQuery(
    "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.login'");
  await login.completeDuo({
    state: stateFrom(challenge.url), nonce: challenge.nonce,
    code: codeFor(`analyst@${seed.a.domain}`),
  });
  const after = await ownerQuery(
    "SELECT count(*)::int AS n, max(detail->>'mfaFactor') AS f FROM audit_log "
    + "WHERE action = 'auth.login'");

  // An `auth.login` entry written when the IdP replied — before Duo — would be
  // a false statement in the one table whose whole value is that it is not.
  assert.equal(after.rows[0].n, mid.rows[0].n + 1, 'auth.login was written at the wrong moment');
  assert.equal(after.rows[0].f, 'duo');

  const challenged = await ownerQuery(
    "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.mfa_challenged'");
  assert.ok(challenged.rows[0].n > 0, 'the challenge itself left no trace');
});

// ─── 2. Duo's answer is about the right person ───────────────────────────────

test('a Duo result for a DIFFERENT person is refused', async () => {
  /**
   * The attack this whole design turns on.
   *
   * An attacker completes Duo perfectly legitimately as themselves, then feeds
   * the resulting callback to a login pending for somebody else. Without the
   * preferred_username comparison in duo.js the second factor passes, for the
   * wrong person, and every other control here is decorative.
   */
  await enableDuo();
  const challenge = await signIn();
  fake.state.claimUsername = 'attacker@evil.example';
  try {
    await assert.rejects(
      () => login.completeDuo({
        state: stateFrom(challenge.url), nonce: challenge.nonce,
        code: codeFor(`analyst@${seed.a.domain}`),
      }),
      (e) => e.code === 'mfa_failed',
      'Duo authenticated someone else and the login was allowed',
    );
  } finally {
    fake.state.claimUsername = null;
  }
  const s = await ownerQuery(
    "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.mfa_failed'");
  assert.ok(s.rows[0].n > 0, 'the refusal left no audit trail');
});

test('exchange() refuses to run without an expected username', async () => {
  // A defaulted or optional argument here would disable the check above
  // silently, at some future call site, with nothing going red.
  const client = new duoMod.DuoClient({
    apiHost: API_HOST, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    redirectUri: 'http://localhost:8080/auth/duo/callback',
  });
  await assert.rejects(() => client.exchange('somecode'),
    (e) => e.code === 'no_expected_username');
});

// ─── 3. The token itself ─────────────────────────────────────────────────────

test('an id_token signed with the wrong key is refused', async () => {
  await enableDuo();
  const challenge = await signIn();
  fake.state.signWith = 'b'.repeat(40);
  try {
    await assert.rejects(
      () => login.completeDuo({
        state: stateFrom(challenge.url), nonce: challenge.nonce,
        code: codeFor(`analyst@${seed.a.domain}`),
      }),
      (e) => e.code === 'mfa_failed',
    );
  } finally {
    fake.state.signWith = null;
  }
});

test('an unsigned token cannot talk its way in', () => {
  // `alg: none` is the oldest JWT bug there is, and it only exists in verifiers
  // that read the algorithm out of the token they are checking.
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ preferred_username: 'x' })}.`;
  assert.throws(() => duoMod.verifyJwt(forged, CLIENT_SECRET),
    (e) => e.code === 'token_alg');
});

test('a token addressed to another client, or expired, is refused', async () => {
  await enableDuo();
  for (const [label, overrides, code] of [
    ['wrong audience', { aud: 'DIYYYYYYYYYYYYYYYYYY' }, 'mfa_failed'],
    ['wrong issuer', { iss: 'https://evil.example/oauth/v1/token' }, 'mfa_failed'],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 10 }, 'mfa_failed'],
    ['issued in the future', { iat: Math.floor(Date.now() / 1000) + 600 }, 'mfa_failed'],
  ]) {
    const challenge = await signIn();
    fake.state.claimOverrides = overrides;
    try {
      await assert.rejects(
        () => login.completeDuo({
          state: stateFrom(challenge.url), nonce: challenge.nonce,
          code: codeFor(`analyst@${seed.a.domain}`),
        }),
        (e) => e.code === code, `${label} was accepted`,
      );
    } finally {
      fake.state.claimOverrides = {};
    }
  }
});

// ─── 4. The pending challenge ────────────────────────────────────────────────

test('a challenge is single-use', async () => {
  await enableDuo();
  const challenge = await signIn();
  const args = {
    state: stateFrom(challenge.url), nonce: challenge.nonce,
    code: codeFor(`analyst@${seed.a.domain}`),
  };
  const first = await login.completeDuo(args);
  assert.equal(first.kind, 'session');
  // A replayable callback is a replayable login: anyone who reads it out of a
  // log, a referrer or a browser history gets a session.
  await assert.rejects(() => login.completeDuo(args), (e) => e.code === 'mfa_failed');
});

test('the state alone is not enough — the browser must hold the cookie too', async () => {
  await enableDuo();
  const challenge = await signIn();
  await assert.rejects(
    () => login.completeDuo({
      state: stateFrom(challenge.url),
      nonce: crypto.randomBytes(32).toString('base64url'),
      code: codeFor(`analyst@${seed.a.domain}`),
    }),
    (e) => e.code === 'mfa_failed',
    'a callback URL was enough on its own, from any browser',
  );
  // And the challenge is still unspent, so the real browser can still finish.
  const done = await login.completeDuo({
    state: stateFrom(challenge.url), nonce: challenge.nonce,
    code: codeFor(`analyst@${seed.a.domain}`),
  });
  assert.equal(done.kind, 'session');
});

test('an expired challenge is refused', async () => {
  await enableDuo();
  const challenge = await signIn();
  await ownerQuery(
    "UPDATE mfa_pending SET expires_at = now() - interval '1 minute' WHERE consumed_at IS NULL");
  await assert.rejects(
    () => login.completeDuo({
      state: stateFrom(challenge.url), nonce: challenge.nonce,
      code: codeFor(`analyst@${seed.a.domain}`),
    }),
    (e) => e.code === 'mfa_failed');
});

test('a tenant suspended mid-flight does not get a session', async () => {
  await enableDuo();
  const challenge = await signIn();
  await ownerQuery("UPDATE tenants SET status = 'suspended' WHERE id = $1", [seed.a.tenantId]);
  try {
    await assert.rejects(
      () => login.completeDuo({
        state: stateFrom(challenge.url), nonce: challenge.nonce,
        code: codeFor(`analyst@${seed.a.domain}`),
      }),
      (e) => e.code === 'tenant_suspended');
  } finally {
    await ownerQuery("UPDATE tenants SET status = 'active' WHERE id = $1", [seed.a.tenantId]);
  }
});

// ─── 5. Fail modes ───────────────────────────────────────────────────────────

test('fail closed: an unreachable Duo stops the login', async () => {
  await enableDuo({ failMode: 'closed' });
  const restore = redirectFetchToFake(1);   // nothing listens on port 1
  try {
    await assert.rejects(() => signIn(), (e) => e.code === 'mfa_failed');
  } finally {
    restore();
    restoreFetch = redirectFetchToFake(fake.port);
  }
});

test('fail open: an unreachable Duo admits, loudly', async () => {
  await enableDuo({ failMode: 'open' });
  const restore = redirectFetchToFake(1);
  let result;
  try {
    result = await signIn();
  } finally {
    restore();
    restoreFetch = redirectFetchToFake(fake.port);
  }
  assert.equal(result.kind, 'session');
  // Three traces, all deliberate: the customer can see it in their own audit
  // log, the operator gets an alarm, and "which sessions skipped Duo" stays
  // answerable months later rather than being inferred.
  const s = await ownerQuery(
    'SELECT mfa_factor FROM sessions ORDER BY issued_at DESC LIMIT 1');
  assert.equal(s.rows[0].mfa_factor, 'duo_failopen');
  const a = await ownerQuery(
    "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.mfa_failopen'");
  assert.ok(a.rows[0].n > 0, 'admitting without a second factor left no audit entry');
});

test('fail open does NOT admit someone Duo actively refused', async () => {
  /**
   * The distinction the whole fail mode turns on. "Duo is down" and "Duo said
   * no" are different events, and a fail-open tenant must only be admitted on
   * the first. Collapsing them turns a convenience into a bypass: an attacker
   * who can make Duo refuse them gets in.
   */
  await enableDuo({ failMode: 'open' });
  const challenge = await signIn();
  assert.equal(challenge.kind, 'mfa', 'Duo was up, so a challenge was expected');

  fake.state.claimUsername = 'attacker@evil.example';
  try {
    await assert.rejects(
      () => login.completeDuo({
        state: stateFrom(challenge.url), nonce: challenge.nonce,
        code: codeFor(`analyst@${seed.a.domain}`),
      }),
      (e) => e.code === 'mfa_failed',
      'fail-open admitted a login Duo had answered about somebody else',
    );
  } finally {
    fake.state.claimUsername = null;
  }
});

// ─── Configuration ───────────────────────────────────────────────────────────

test('the client secret is never stored in the clear', async () => {
  await enableDuo();
  const { rows } = await ownerQuery(
    'SELECT client_secret_ct FROM tenant_duo WHERE tenant_id = $1', [seed.a.tenantId]);
  const blob = rows[0].client_secret_ct;
  assert.ok(Buffer.isBuffer(blob));
  assert.ok(!blob.toString('utf8').includes(CLIENT_SECRET), 'the secret is in the row');
  assert.ok(!blob.toString('latin1').includes(CLIENT_SECRET));
  // And it is bound to this tenant: the same ciphertext under another tenant's
  // id does not open, because the tenant id is the AAD.
  const envelope = require('../src/crypto/envelope');
  assert.throws(() => envelope.open(mfa.duoKey(), seed.b.tenantId, blob));
  assert.equal(envelope.open(mfa.duoKey(), seed.a.tenantId, blob).toString('utf8'),
    CLIENT_SECRET);
});

test('a hostname that is not Duo is refused before any request is made', () => {
  // This value becomes the host of an outbound call from inside the VPC,
  // carrying a signed client assertion.
  for (const host of ['evil.example', 'api-deadbeef.duosecurity.com.evil.example',
    'localhost', 'api-zzzz.duosecurity.com', '']) {
    assert.throws(() => new duoMod.DuoClient({
      apiHost: host, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      redirectUri: 'https://api.example/auth/duo/callback',
    }), (e) => e.code === 'config_api_host', `${host} was accepted`);
  }
});

test('enable refuses a configuration that has never passed a health check', async () => {
  // Enabling puts a second factor in front of every user at the firm. A
  // configuration nobody has proven works would put a broken one there.
  await ownerQuery('UPDATE tenant_duo SET verified_at = NULL WHERE tenant_id = $1',
    [seed.a.tenantId]);
  await assert.rejects(() => admin.enable({ slug: 'firm-x' }),
    /never passed a health check/);
  await ownerQuery('UPDATE tenant_duo SET verified_at = now() WHERE tenant_id = $1',
    [seed.a.tenantId]);
});

test('the username travels signed, not as an editable parameter', () => {
  const client = new duoMod.DuoClient({
    apiHost: API_HOST, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    redirectUri: 'https://api.example/auth/duo/callback',
  });
  const url = new URL(client.authUrl({
    username: 'analyst@firmx.com',
    state: 'x'.repeat(40),
  }));
  // Not in the query string where the address bar can reach it.
  assert.ok(!url.search.includes('analyst%40firmx.com'), url.search);
  // Inside the signed request object instead.
  const request = url.searchParams.get('request');
  const claims = JSON.parse(Buffer.from(request.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.duo_uname, 'analyst@firmx.com');
  assert.equal(claims.use_duo_code_attribute, true);
  // And that request object is itself signed, so editing it invalidates it.
  assert.doesNotThrow(() => duoMod.verifyJwt(request, CLIENT_SECRET));
  assert.throws(() => duoMod.verifyJwt(request, 'c'.repeat(40)));
});

// ─── Home realm discovery ────────────────────────────────────────────────────

test('an email address routes to its firm, and an unknown one reveals nothing', async () => {
  assert.equal(await login.discoverTenant(`analyst@${seed.a.domain}`), 'firm-x');
  assert.equal(await login.discoverTenant(`someone@${seed.b.domain}`), 'firm-y');
  // Null, not an error and not a different shape of answer: the caller sends
  // the browser down the same path either way, so a stranger cannot read the
  // customer list one domain at a time.
  assert.equal(await login.discoverTenant('someone@nobody.example'), null);
  assert.equal(await login.discoverTenant('not-an-address'), null);
  assert.equal(await login.discoverTenant(''), null);
});

test('an UNVERIFIED domain does not route', async () => {
  // Routing on an unverified claim would let a firm that typed a competitor's
  // domain during onboarding decide where that competitor's users get sent.
  await ownerQuery(
    `INSERT INTO tenant_domains (tenant_id, domain, verified_at) VALUES ($1,'claimed.example',NULL)
     ON CONFLICT (tenant_id, domain) DO UPDATE SET verified_at = NULL`,
    [seed.a.tenantId]);
  assert.equal(await login.discoverTenant('someone@claimed.example'), null);
});

// ─── The HTTP layer ──────────────────────────────────────────────────────────
/**
 * Everything above calls login.completeDuo() directly, which leaves the part
 * the browser actually touches untested: the pending cookie. That cookie is the
 * browser-binding half of the challenge, and a bug in setting or reading it
 * would not fail any test above — it would simply mean the binding is not
 * there, silently, while every unit test still passed.
 */

let server, base;

async function startApi() {
  if (server) return;
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

/** Cookies a response sets, as a name → value map. */
function setCookies(res) {
  const out = {};
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair, ...attrs] = c.split(';');
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq).trim()] = {
      value: decodeURIComponent(pair.slice(eq + 1).trim()),
      attrs: attrs.map((a) => a.trim()),
    };
  }
  return out;
}

test('the callback redirects to Duo and sets an httpOnly pending cookie', async () => {
  await startApi();
  await enableDuo();

  const begun = await login.begin({ redirectTo: '/' });
  const code = `c-${crypto.randomUUID()}`;
  stub.__setProfile(code, {
    organizationId: 'org_x', email: `analyst@${seed.a.domain}`,
    emailVerified: true, externalId: 'stub|analyst', name: 'An Analyst',
  });

  const res = await fetch(
    `${base}/auth/callback?state=${encodeURIComponent(begun.state)}&code=${code}`,
    { redirect: 'manual' });

  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(location.startsWith(`https://${API_HOST}/oauth/v1/authorize`), location);

  const cookies = setCookies(res);
  // No session cookie yet. This is the invariant, seen from the browser's side.
  assert.equal(cookies.cre_session, undefined,
    'a session cookie was set before the second factor');

  const pending = cookies.cre_mfa_pending;
  assert.ok(pending, 'no pending cookie was set, so the challenge is not bound to this browser');
  assert.ok(pending.attrs.includes('HttpOnly'),
    'the pending handle is readable by script');
  assert.ok(pending.attrs.some((a) => /^SameSite=Lax$/i.test(a)),
    'SameSite must be Lax: Duo returns the browser by a top-level navigation, '
    + 'and Strict would withhold the cookie on exactly that request');
  // Scoped to /auth, so it is not attached to every API call for the rest of
  // the session lifetime.
  assert.ok(pending.attrs.some((a) => /^Path=\/auth$/i.test(a)), pending.attrs.join('; '));
});

test('the Duo callback exchanges the cookie for a session, and clears it', async () => {
  await startApi();
  await enableDuo();

  const begun = await login.begin({ redirectTo: '/' });
  const code = `c-${crypto.randomUUID()}`;
  stub.__setProfile(code, {
    organizationId: 'org_x', email: `analyst@${seed.a.domain}`,
    emailVerified: true, externalId: 'stub|analyst', name: 'An Analyst',
  });
  const first = await fetch(
    `${base}/auth/callback?state=${encodeURIComponent(begun.state)}&code=${code}`,
    { redirect: 'manual' });
  const pending = setCookies(first).cre_mfa_pending.value;
  const duoState = new URL(first.headers.get('location')).searchParams.get('state');

  const res = await fetch(
    `${base}/auth/duo/callback?state=${encodeURIComponent(duoState)}`
    + `&duo_code=${codeFor(`analyst@${seed.a.domain}`)}`,
    { redirect: 'manual', headers: { cookie: `cre_mfa_pending=${encodeURIComponent(pending)}` } });

  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').startsWith('http://localhost:3000'),
    res.headers.get('location'));

  const cookies = setCookies(res);
  assert.ok(cookies.cre_session?.value, 'no session cookie after a successful second factor');
  // The pending handle is single-use; leaving it in the browser is leaving a
  // spent credential lying about.
  assert.equal(cookies.cre_mfa_pending.value, '', 'the pending cookie was not cleared');
});

test('a Duo callback with no cookie gets no session', async () => {
  await startApi();
  await enableDuo();

  const begun = await login.begin({ redirectTo: '/' });
  const code = `c-${crypto.randomUUID()}`;
  stub.__setProfile(code, {
    organizationId: 'org_x', email: `analyst@${seed.a.domain}`,
    emailVerified: true, externalId: 'stub|analyst', name: 'An Analyst',
  });
  const first = await fetch(
    `${base}/auth/callback?state=${encodeURIComponent(begun.state)}&code=${code}`,
    { redirect: 'manual' });
  const duoState = new URL(first.headers.get('location')).searchParams.get('state');

  // The whole callback URL, from a browser that never started the handshake.
  const res = await fetch(
    `${base}/auth/duo/callback?state=${encodeURIComponent(duoState)}`
    + `&duo_code=${codeFor(`analyst@${seed.a.domain}`)}`,
    { redirect: 'manual' });

  assert.equal(setCookies(res).cre_session, undefined,
    'a stolen callback URL was enough to get a session');
  assert.match(res.headers.get('location'), /\/signin\?error=mfa_failed/);
});

test('a denied push comes back as a refusal, not a session', async () => {
  await startApi();
  await enableDuo();

  const begun = await login.begin({ redirectTo: '/' });
  const code = `c-${crypto.randomUUID()}`;
  stub.__setProfile(code, {
    organizationId: 'org_x', email: `analyst@${seed.a.domain}`,
    emailVerified: true, externalId: 'stub|analyst', name: 'An Analyst',
  });
  const first = await fetch(
    `${base}/auth/callback?state=${encodeURIComponent(begun.state)}&code=${code}`,
    { redirect: 'manual' });
  const pending = setCookies(first).cre_mfa_pending.value;
  const duoState = new URL(first.headers.get('location')).searchParams.get('state');

  // Duo reports a declined push or a timeout as an error parameter.
  const res = await fetch(
    `${base}/auth/duo/callback?state=${encodeURIComponent(duoState)}&error=access_denied`,
    { redirect: 'manual', headers: { cookie: `cre_mfa_pending=${encodeURIComponent(pending)}` } });

  assert.equal(setCookies(res).cre_session, undefined);
  assert.match(res.headers.get('location'), /\/signin\?error=mfa_denied/);
});

test('an email address on /auth/start routes to the right provider', async () => {
  await startApi();
  await disableDuo();
  const res = await fetch(
    `${base}/auth/start?email=${encodeURIComponent(`analyst@${seed.a.domain}`)}`,
    { redirect: 'manual' });
  assert.equal(res.status, 302);

  // And an unknown domain is not told it is unknown: same status, same shape of
  // answer, so a stranger cannot read the customer list one domain at a time.
  const unknown = await fetch(
    `${base}/auth/start?email=${encodeURIComponent('someone@nobody.example')}`,
    { redirect: 'manual' });
  assert.equal(unknown.status, 302);
  assert.equal(res.status, unknown.status);
});

test('the pending handle is accepted ONLY from the cookie, never from the URL', async () => {
  /**
   * Found by mutation testing, not by reading the code.
   *
   * Changing the handler to `req.query.nonce || readCookie(...)` — the kind of
   * "helpful" fallback someone adds while debugging a redirect — passed every
   * other test in this file. It also removes the browser binding entirely: the
   * whole callback URL becomes sufficient on its own, which is the property the
   * cookie exists to deny.
   */
  await startApi();
  await enableDuo();

  const begun = await login.begin({ redirectTo: '/' });
  const code = `c-${crypto.randomUUID()}`;
  stub.__setProfile(code, {
    organizationId: 'org_x', email: `analyst@${seed.a.domain}`,
    emailVerified: true, externalId: 'stub|analyst', name: 'An Analyst',
  });
  const first = await fetch(
    `${base}/auth/callback?state=${encodeURIComponent(begun.state)}&code=${code}`,
    { redirect: 'manual' });
  const pending = setCookies(first).cre_mfa_pending.value;
  const duoState = new URL(first.headers.get('location')).searchParams.get('state');

  // The correct handle, in the URL, with no cookie at all — which is what an
  // attacker who has read the handle out of a log or a referrer would have.
  const res = await fetch(
    `${base}/auth/duo/callback?state=${encodeURIComponent(duoState)}`
    + `&nonce=${encodeURIComponent(pending)}`
    + `&duo_code=${codeFor(`analyst@${seed.a.domain}`)}`,
    { redirect: 'manual' });

  assert.equal(setCookies(res).cre_session, undefined,
    'the pending handle was accepted from the query string, so the cookie binds nothing');
  assert.match(res.headers.get('location'), /\/signin\?error=mfa_failed/);

  // And the challenge survives, so the legitimate browser can still finish.
  const good = await fetch(
    `${base}/auth/duo/callback?state=${encodeURIComponent(duoState)}`
    + `&duo_code=${codeFor(`analyst@${seed.a.domain}`)}`,
    { redirect: 'manual', headers: { cookie: `cre_mfa_pending=${encodeURIComponent(pending)}` } });
  assert.ok(setCookies(good).cre_session?.value);
});
