'use strict';

/**
 * The SSO preflight.
 *
 * A preflight is a thing people ACT ON: it says the integration is sound, and
 * someone onboards a firm. So the property that matters most is not that it
 * passes when things are right — it is that it never passes when it has not
 * actually established anything.
 *
 * That is not hypothetical. The first version of checkCredentials() treated
 * "not 401, not ok" as success. Run from behind an egress proxy it received a
 * 403 with an HTML body, reported "credentials accepted", and printed
 * PREFLIGHT PASSED, having never reached WorkOS at all. These tests exist so
 * that cannot come back.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.SSO_PROVIDER = 'workos';
process.env.WORKOS_API_KEY = 'sk_test_key';
process.env.WORKOS_CLIENT_ID = 'client_test';

const { checkCredentials, checkExchange } = require('../src/admin/ssoCheck');

const quiet = () => {
  const real = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => { console.log = real; } };
};

/** Run something with console captured, so the suite output stays readable. */
async function run(fn) {
  const q = quiet();
  try { return { result: await fn(), lines: q.lines }; } finally { q.restore(); }
}

const respond = (status, body, json = true) => {
  global.fetch = async () => ({
    ok: status < 400,
    status,
    json: async () => { if (!json) throw new Error('not json'); return body; },
  });
};

test.afterEach(() => { delete global.fetch; });

test('an egress proxy answering with no JSON body does NOT pass', async () => {
  // The exact false pass that shipped. A 403 from a proxy is not evidence about
  // anyone's credentials.
  respond(403, null, false);
  const { result, lines } = await run(checkCredentials);
  assert.equal(result, false);
  assert.ok(lines.join('\n').includes('did not come from WorkOS'));
});

test('an HTML error page does not pass', async () => {
  respond(502, null, false);
  assert.equal((await run(checkCredentials)).result, false);
});

test('a JSON error that is not about the code does not pass', async () => {
  // Something is answering, but it is not WorkOS refusing an invalid code.
  respond(400, { message: 'Bad Gateway', origin: 'cdn' });
  const { result, lines } = await run(checkCredentials);
  assert.equal(result, false);
  assert.ok(lines.join('\n').includes('unrecognised error'));
});

test('rejected credentials are reported as such, not as a network problem', async () => {
  respond(401, { code: 'invalid_client', message: 'Invalid client credentials' });
  const { result, lines } = await run(checkCredentials);
  assert.equal(result, false);
  assert.ok(lines.join('\n').includes('rejected the credentials'));
});

test('an invalid code being rejected IS the pass condition', async () => {
  // Positive evidence: only WorkOS produces this, so it proves both that we
  // reached them and that they accepted the credentials.
  respond(400, { code: 'invalid_grant', message: 'The code provided is invalid' });
  const { result } = await run(checkCredentials);
  assert.equal(result, true);
});

test('an invalid code being ACCEPTED fails loudly', async () => {
  // Impossible against the real API; means we are pointed at a mock.
  respond(200, { access_token: 'x', profile: {} });
  const { result, lines } = await run(checkCredentials);
  assert.equal(result, false);
  assert.ok(lines.join('\n').includes('should be impossible'));
});

test('a full exchange reports a shape the parser cannot read', async () => {
  // The failure the script exists to find: their envelope moved.
  respond(200, { data: { user: { email: 'a@b.com' } } });
  const { result, lines } = await run(() => checkExchange('code_real'));
  assert.equal(result, false);
  const out = lines.join('\n');
  assert.ok(out.includes('could not read the response'));
  assert.ok(out.includes('THIS IS THE FAILURE THIS SCRIPT EXISTS TO FIND'));
});

test('a full exchange passes on a documented body and masks the address', async () => {
  respond(200, {
    access_token: 'tok',
    profile: {
      id: 'prof_1', idp_id: 'idp_1', organization_id: 'org_1', connection_id: 'conn_1',
      connection_type: 'OktaSAML', email: 'analyst@firmx.com',
      first_name: 'An', last_name: 'Analyst',
    },
  });
  const { result, lines } = await run(() => checkExchange('code_real'));
  assert.equal(result, true);
  const out = lines.join('\n');
  assert.ok(out.includes('org_1'), 'the organization id must be shown for comparison');
  // Printed to a terminal that may be shared or pasted into a ticket.
  assert.ok(!out.includes('analyst@firmx.com'), 'the full address was printed');
  assert.ok(out.includes('a***@firmx.com'), 'the masked address should appear');
});

test('a stale or reused authorization code says so', async () => {
  respond(400, { code: 'invalid_grant', message: 'code expired' });
  const { result, lines } = await run(() => checkExchange('code_stale'));
  assert.equal(result, false);
  assert.ok(lines.join('\n').includes('single-use'));
});
