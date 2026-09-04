'use strict';

/**
 * The WorkOS client, against a fake transport.
 *
 * WHAT THIS CANNOT DO: prove WorkOS behaves the way this file says it does. No
 * request here leaves the process. If their API renamed `organization_id`
 * tomorrow, every test below would still pass.
 *
 * WHAT IT DOES DO, which is worth having:
 *
 *   1. Pins the exact request we send — URL, method, content type, and every
 *      body parameter. A change on our side is caught here rather than by a
 *      firm's first login attempt.
 *   2. Documents, executably, the response shape we believe we are parsing. A
 *      reader comparing this to WorkOS's docs can spot a mismatch in a minute.
 *   3. Proves that when the shape is NOT what we expect, the failure names the
 *      problem instead of masquerading as a misconfigured identity provider.
 *
 * The remaining gap is closed by `npm run sso:check`, which makes one real
 * exchange with real credentials. See src/admin/ssoCheck.js.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.SSO_PROVIDER = 'workos';
process.env.WORKOS_API_KEY = 'sk_test_key';
process.env.WORKOS_CLIENT_ID = 'client_test';
process.env.WORKOS_REDIRECT_URI = 'https://api.example.com/auth/callback';

const { workosBroker, parseProfile } = require('../src/auth/broker');

/** A success body in the shape the WorkOS SSO API documents. */
const PROFILE_BODY = {
  access_token: '01DMEK...redacted',
  profile: {
    id: 'prof_01E',
    idp_id: '00u1a8merRhe4a',
    organization_id: 'org_01EHZ',
    connection_id: 'conn_01E',
    connection_type: 'OktaSAML',
    email: 'analyst@firmx.com',
    first_name: 'An',
    last_name: 'Analyst',
  },
};

function fakeFetch(response, capture = {}) {
  global.fetch = async (url, init) => {
    capture.url = String(url);
    capture.init = init;
    return {
      ok: response.status < 400,
      status: response.status,
      json: async () => response.body,
    };
  };
  return capture;
}

test.afterEach(() => { delete global.fetch; });

test('the authorization URL carries client, redirect, response type and state', () => {
  const u = new URL(workosBroker().authorizationUrl({ state: 'st_123', organizationId: 'org_01EHZ' }));
  assert.equal(u.origin + u.pathname, 'https://api.workos.com/sso/authorize');
  assert.equal(u.searchParams.get('client_id'), 'client_test');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://api.example.com/auth/callback');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 'st_123');
  assert.equal(u.searchParams.get('organization'), 'org_01EHZ');
});

test('omitting the organization asks the broker to choose the directory', () => {
  const u = new URL(workosBroker().authorizationUrl({ state: 'st_123' }));
  assert.equal(u.searchParams.get('organization'), null);
  assert.equal(u.searchParams.get('state'), 'st_123');
});

test('the token exchange posts form-encoded credentials to /sso/token', async () => {
  const cap = fakeFetch({ status: 200, body: PROFILE_BODY });
  await workosBroker().exchange('code_abc');

  assert.equal(cap.url, 'https://api.workos.com/sso/token');
  assert.equal(cap.init.method, 'POST');
  assert.equal(cap.init.headers['content-type'], 'application/x-www-form-urlencoded');

  const sent = new URLSearchParams(cap.init.body.toString());
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('client_id'), 'client_test');
  assert.equal(sent.get('client_secret'), 'sk_test_key');
  assert.equal(sent.get('code'), 'code_abc');
});

test('a documented success body maps onto the profile the system uses', async () => {
  fakeFetch({ status: 200, body: PROFILE_BODY });
  const p = await workosBroker().exchange('code_abc');
  assert.deepEqual(p, {
    organizationId: 'org_01EHZ',
    email: 'analyst@firmx.com',
    emailVerified: true,
    externalId: '00u1a8merRhe4a',
    name: 'An Analyst',
    connectionId: 'conn_01E',
    idpName: 'OktaSAML',
  });
});

test('the profile id is used when the IdP supplied no subject of its own', () => {
  const { idp_id: _drop, ...rest } = PROFILE_BODY.profile;
  const p = parseProfile({ profile: rest });
  assert.equal(p.externalId, 'prof_01E');
});

test('a partial name does not produce a dangling space', () => {
  const p = parseProfile({ profile: { ...PROFILE_BODY.profile, last_name: null } });
  assert.equal(p.name, 'An');
  const none = parseProfile({
    profile: { ...PROFILE_BODY.profile, first_name: null, last_name: null },
  });
  assert.equal(none.name, null);
});

test('a non-2xx exchange fails without echoing the body', async () => {
  // The error body can contain the authorization code. It must not reach a log.
  fakeFetch({ status: 401, body: { error: 'invalid_client', code: 'code_abc' } });
  await assert.rejects(
    () => workosBroker().exchange('code_abc'),
    (e) => e.status === 502
      && /401/.test(e.message)
      && !/code_abc/.test(e.message)
      && !/invalid_client/.test(e.message),
  );
});

describe_shape_failures();

function describe_shape_failures() {
  /**
   * The point of the whole exercise. Before this, an unexpected envelope left
   * every field undefined and login.complete() threw `no_org`, which reaches
   * the user as "your identity provider did not identify your organization" —
   * sending someone into their Okta configuration for a fault that is ours.
   */
  test('an envelope with no profile names the problem', () => {
    for (const body of [{}, { data: {} }, { access_token: 'x' }, null, 'a string', []]) {
      assert.throws(
        () => parseProfile(body),
        (e) => e.code === 'sso_shape' && /no `profile` object/.test(e.message),
        `envelope ${JSON.stringify(body)} did not raise a shape error`,
      );
    }
  });

  test('a profile missing the organization names the field, not the IdP', () => {
    const { organization_id: _drop, ...rest } = PROFILE_BODY.profile;
    assert.throws(
      () => parseProfile({ profile: rest }),
      (e) => e.code === 'sso_shape'
        && /missing organization_id/.test(e.message)
        // The diagnostic lists what WAS there, which is what makes a shape
        // change readable at a glance instead of a guessing game.
        && /profile keys: /.test(e.message),
    );
  });

  test('a profile missing the email names the field', () => {
    const { email: _drop, ...rest } = PROFILE_BODY.profile;
    assert.throws(
      () => parseProfile({ profile: rest }),
      (e) => e.code === 'sso_shape' && /missing email/.test(e.message),
    );
  });

  test('a shape error never leaks the access token or personal data', () => {
    // This message reaches the logs. Key names only.
    try {
      parseProfile({ access_token: 'secret_token_value', user: { email: 'someone@firm.com' } });
      assert.fail('expected a shape error');
    } catch (e) {
      assert.ok(!/secret_token_value/.test(e.message), 'the access token reached the message');
      assert.ok(!/someone@firm\.com/.test(e.message), 'an email reached the message');
      assert.ok(/access_token, user/.test(e.message), 'the key names should be listed');
    }
  });
}
