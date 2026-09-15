'use strict';

/**
 * Idle expiry, rate limiting and key rotation.
 *
 * Each of these is a control that is easy to add in a form that does nothing.
 * An idle timeout that never fires, a limiter that counts the load balancer
 * instead of the caller, a rotation window that still logs everyone out — all
 * pass a questionnaire and none of them works. These tests exercise the
 * behaviour, not the presence.
 */

const test = require('node:test');
const assert = require('node:assert');
const { freshDatabase, seedTwoTenants } = require('./helpers');

process.env.SSO_PROVIDER = 'stub';

let env, seed, pool, session, login, brokerMod, stub, createApp, server, base;

test.before(async () => {
  env = await freshDatabase('hardening');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.APP_ORIGIN = 'http://localhost:3000';
  // Short windows so the test does not sleep for an hour.
  process.env.SESSION_IDLE_MS = '400';
  process.env.SESSION_TOUCH_INTERVAL_MS = '50';
  pool = require('../src/db/pool');
  session = require('../src/auth/session');
  login = require('../src/auth/login');
  brokerMod = require('../src/auth/broker');
  stub = brokerMod.broker();
  ({ createApp } = require('../src/app'));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(over = {}) {
  const begun = await login.begin({ redirectTo: '/' });
  const code = new URL(begun.url).searchParams.get('code');
  stub.__setProfile(code, {
    organizationId: 'org_x', email: 'analyst@firmx.com', emailVerified: true,
    externalId: 'idp|1', name: 'An Analyst', connectionId: 'c', idpName: 'stub',
    ...over,
  });
  return login.complete({ state: begun.state, code, ip: '198.51.100.7' });
}

describe_idle();
describe_mfa_policy();
describe_rotation();
describe_limits();

function describe_idle() {
  test('a session left idle past the window stops working', async () => {
    const { token } = await signIn();
    assert.ok(await session.resolve(token), 'should resolve immediately after sign-in');
    await sleep(500);
    assert.equal(await session.resolve(token), null, 'an idle session must expire');
  });

  test('an idle-expired session is REVOKED, not merely refused', async () => {
    // A dormant session that would work again if the clock were nudged is not
    // expired, it is waiting.
    const { token } = await signIn();
    await sleep(500);
    await session.resolve(token);
    const { rows } = await pool.authPool.query(
      'SELECT revoked_at FROM sessions ORDER BY issued_at DESC LIMIT 1');
    assert.ok(rows[0].revoked_at, 'the session should have been revoked on idle expiry');
  });

  test('activity keeps a session alive past the idle window', async () => {
    // The timeout must be idle-based, not a second absolute clock.
    const { token } = await signIn();
    for (let i = 0; i < 4; i += 1) {
      await sleep(150);
      assert.ok(await session.resolve(token), `session died at check ${i} despite activity`);
    }
  });
}

function describe_mfa_policy() {
  test('a tenant requiring MFA refuses a login the IdP did not vouch for', async () => {
    const { Client } = require('pg');
    const owner = new Client({ connectionString: env.ownerUrl });
    await owner.connect();
    await owner.query('UPDATE tenants SET require_mfa = true WHERE id = $1', [seed.a.tenantId]);
    try {
      await assert.rejects(
        () => signIn({ authMethod: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password' }),
        (e) => e.code === 'mfa_required' && e.status === 403,
      );
      // And admits one it did.
      const ok = await signIn({
        authMethod: 'urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactorAuthentication',
      });
      assert.ok(ok.token);
    } finally {
      await owner.query('UPDATE tenants SET require_mfa = NULL WHERE id = $1', [seed.a.tenantId]);
      await owner.end();
    }
  });

  test('with no policy set, a login without an MFA claim is admitted', async () => {
    // NULL means "no policy", not "off". Treating it as a requirement would
    // lock out every tenant whose provider omits the claim — most of them.
    const r = await signIn();
    assert.ok(r.token);
  });

  test('the session records how the person authenticated', async () => {
    const { token } = await signIn({ authMethod: 'urn:okta:loginContext:webauthn' });
    const s = await session.resolve(token);
    assert.equal(s.authMethod, 'urn:okta:loginContext:webauthn');
    assert.equal(s.mfaAsserted, true);
  });
}

function describe_rotation() {
  test('a CSRF token signed with the outgoing key is still accepted', async () => {
    // Without a rotation window, changing the signing secret invalidates every
    // in-flight token at once and every user's next save fails.
    const { token } = await signIn();
    const s = await session.resolve(token);
    const underCurrent = session.csrfToken(s.sessionId);

    const config = require('../src/config');
    const original = config.session.signingSecret;
    try {
      config.session.previousSigningSecret = original;
      config.session.signingSecret = 'a-freshly-rotated-secret-of-sufficient-length!!';
      assert.ok(session.csrfValid(s.sessionId, underCurrent),
        'a token from the outgoing key must survive the rotation window');
      assert.ok(session.csrfValid(s.sessionId, session.csrfToken(s.sessionId)),
        'a token from the new key must work');
      assert.ok(!session.csrfValid(s.sessionId, 'neither-key-signed-this'),
        'an unsigned token must still be refused');
    } finally {
      config.session.signingSecret = original;
      config.session.previousSigningSecret = null;
    }
  });

  test('with no previous key configured, only the current key is accepted', async () => {
    const { token } = await signIn();
    const s = await session.resolve(token);
    const config = require('../src/config');
    const forged = require('crypto')
      .createHmac('sha256', 'some-other-key-entirely-long-enough-to-pass')
      .update(`csrf:${s.sessionId}`).digest('base64url');
    assert.equal(config.session.previousSigningSecret, null);
    assert.ok(!session.csrfValid(s.sessionId, forged));
  });
}

function describe_limits() {
  test('the auth path is rate limited, and says when to retry', async () => {
    const { __reset } = require('../src/middleware/rateLimit');
    __reset();
    let limited = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await fetch(`${base}/auth/start`, { redirect: 'manual' });
      if (res.status === 429) { limited = res; break; }
    }
    assert.ok(limited, '/auth/start was never limited across 40 attempts');
    assert.ok(limited.headers.get('retry-after'), 'a 429 must say when to retry');
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });
    __reset();
  });

  test('a 429 body reveals nothing about the limit or the caller', async () => {
    // A limiter that explains itself is a limiter someone tunes around.
    const { __reset } = require('../src/middleware/rateLimit');
    __reset();
    let body = '';
    for (let i = 0; i < 40; i += 1) {
      const res = await fetch(`${base}/auth/start`, { redirect: 'manual' });
      if (res.status === 429) { body = await res.text(); break; }
    }
    assert.ok(!/\d{2,}/.test(body), `the body leaked a number: ${body}`);
    __reset();
  });

  test('ordinary use is nowhere near the ceiling', async () => {
    // A limiter that fires during normal work trains everyone to ignore it.
    const { __reset } = require('../src/middleware/rateLimit');
    __reset();
    for (let i = 0; i < 25; i += 1) {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200, `normal traffic was limited at request ${i}`);
    }
    __reset();
  });
}
