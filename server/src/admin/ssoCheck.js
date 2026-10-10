'use strict';

const config = require('../config');
const { parseProfile } = require('../auth/broker');

/**
 * Preflight the real WorkOS integration.
 *
 * WHY THIS EXISTS. Everything else about the SSO path is tested against a stub
 * or a fake transport, which proves our code is self-consistent and proves
 * nothing about WorkOS. A renamed field or a changed envelope would be
 * discovered by a client firm's first login — the worst possible time and the
 * worst possible audience. This turns that into one command, run before anyone
 * depends on it.
 *
 *   npm run sso:check
 *   npm run sso:check -- --code=<authorization code from a real browser login>
 *
 * WITHOUT a code it verifies what does not need a browser: that the credentials
 * are accepted, that the endpoint is where we think it is, and what shape their
 * errors take. That covers most of the risk, because the usual failure is a
 * wrong key or an unregistered redirect URI, not an exotic parsing bug.
 *
 * WITH a code — captured from a real sign-in — it does the full exchange and
 * compares the returned profile field by field against what the parser expects.
 * That is the only thing that fully closes the gap.
 *
 * To capture a code: set WORKOS_REDIRECT_URI to a URL you control, complete a
 * sign-in in a browser, and take the `code` query parameter off the callback.
 * It is single-use and expires in minutes, so run this immediately.
 */

const ESC = String.fromCharCode(27);
const GREEN = ESC + '[32m';
const RED = ESC + '[31m';
const DIM = ESC + '[2m';
const OFF = ESC + '[0m';
const ok = (m) => console.log(GREEN + '  ok' + OFF + '  ' + m);
const bad = (m) => console.log(RED + 'FAIL' + OFF + '  ' + m);
const note = (m) => console.log(DIM + '      ' + m + OFF);

async function checkConfig() {
  console.log('\nConfiguration');
  const { apiKey, clientId, redirectUri, apiBase } = config.sso.workos;
  let good = true;

  if (!apiKey) {
    bad('WORKOS_API_KEY is not set');
    good = false;
  } else {
    // Never print a secret. Its prefix is enough to catch the common mistake of
    // pasting a publishable key where a secret key belongs.
    ok('WORKOS_API_KEY present (' + apiKey.slice(0, 7) + '...)');
    if (!apiKey.startsWith('sk_')) {
      bad('that does not look like a secret key - WorkOS secret keys begin sk_');
      good = false;
    }
  }
  if (!clientId) { bad('WORKOS_CLIENT_ID is not set'); good = false; }
  else ok('WORKOS_CLIENT_ID ' + clientId);

  if (!redirectUri) { bad('WORKOS_REDIRECT_URI is not set'); good = false; }
  else {
    ok('WORKOS_REDIRECT_URI ' + redirectUri);
    note('must match a redirect registered in the WorkOS dashboard EXACTLY,');
    note('including scheme, host, port and path.');
  }
  console.log('      API base ' + apiBase);
  return good;
}

/**
 * Exchange a deliberately invalid code.
 *
 * The DISTINCTION is the whole test. Bad credentials and a bad code are
 * different errors, so an invalid-code response proves the credentials were
 * accepted - without needing a browser.
 */
async function checkCredentials() {
  console.log('\nCredentials (exchanging a deliberately invalid code)');
  const { apiKey, clientId, apiBase } = config.sso.workos;
  let res;
  try {
    res = await fetch(new URL('/sso/token', apiBase), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: apiKey,
        grant_type: 'authorization_code',
        code: 'preflight_intentionally_invalid_code',
      }),
    });
  } catch (err) {
    bad('could not reach ' + apiBase + ': ' + err.message);
    note('a proxy, an egress rule or DNS - not a credential problem.');
    return false;
  }

  let payload = null;
  try { payload = await res.json(); } catch { /* not every error body is JSON */ }
  const errCode = (payload && (payload.code || payload.error)) || '';
  const message = (payload && (payload.message || payload.error_description)) || '';

  console.log('      HTTP ' + res.status + '  ' + DIM + (errCode || '(no error code)') + OFF);

  if (res.status === 401 || /invalid_client|unauthorized/i.test(errCode + ' ' + message)) {
    bad('WorkOS rejected the credentials');
    note('check WORKOS_API_KEY and WORKOS_CLIENT_ID belong to the same environment');
    note('(a staging key with a production client id fails exactly like this).');
    return false;
  }
  if (res.ok) {
    bad('an invalid code was ACCEPTED - that should be impossible');
    note('verify you are pointed at api.workos.com and not a mock.');
    return false;
  }

  // POSITIVE EVIDENCE REQUIRED, and this is the whole correctness of the check.
  //
  // An earlier version treated "not 401, not ok" as success. Run from behind an
  // egress proxy it got a 403 with an HTML body, reported "credentials
  // accepted", and printed PREFLIGHT PASSED - having never reached WorkOS at
  // all. A preflight that passes when the network is blocked is worse than no
  // preflight, because someone acts on it.
  //
  // So we insist on something only WorkOS produces: a JSON error body naming
  // the code as the problem. A proxy, a WAF or a captive portal returns HTML,
  // or JSON with entirely different keys, and none of that is confirmation.
  if (!payload) {
    bad('HTTP ' + res.status + ' with no JSON body - this did not come from WorkOS');
    note('a proxy, a WAF or an egress filter is answering instead. Nothing about');
    note('the credentials has been verified.');
    return false;
  }
  if (!/grant|code|invalid_request/i.test(errCode + ' ' + message)) {
    bad('HTTP ' + res.status + ' with an unrecognised error: ' + (errCode || '(none)'));
    note('expected an invalid-code error. Body keys: ' + Object.keys(payload).join(', '));
    note('either the API has changed or something is answering on its behalf.');
    return false;
  }

  ok('credentials accepted; the invalid code was rejected as expected');
  note('their error envelope keys: ' + Object.keys(payload).join(', '));
  return true;
}

/**
 * The full exchange, with a real code. The only place the parser meets a real
 * WorkOS response, and therefore the only thing that fully closes the gap.
 */
async function checkExchange(code) {
  console.log('\nFull exchange with a real authorization code');
  const { apiKey, clientId, apiBase } = config.sso.workos;

  const res = await fetch(new URL('/sso/token', apiBase), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: apiKey, grant_type: 'authorization_code', code,
    }),
  });
  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    bad('HTTP ' + res.status + ' - ' + ((payload && (payload.code || payload.error)) || 'no error code'));
    note('an authorization code is single-use and expires in minutes; capture a fresh one.');
    return false;
  }

  console.log('      top-level keys: ' + Object.keys(payload).join(', '));
  if (payload.profile) console.log('      profile keys:   ' + Object.keys(payload.profile).join(', '));

  let profile;
  try {
    profile = parseProfile(payload);
  } catch (err) {
    bad('the parser could not read the response: ' + err.message);
    note('THIS IS THE FAILURE THIS SCRIPT EXISTS TO FIND. Their shape has moved');
    note('away from what src/auth/broker.js expects. Update parseProfile() and');
    note('the fixture in test/workos.test.js together.');
    return false;
  }

  ok('the response parsed');
  // Field by field, because "it parsed" is not "it is right": a present-but-
  // wrong organization id would admit a user to the WRONG TENANT, which is the
  // one mistake this whole system exists to prevent.
  let complete = true;
  for (const [field, value] of Object.entries(profile)) {
    const shown = field === 'email' ? String(value).replace(/(.).*(@.*)/, '$1***$2') : value;
    if (['organizationId', 'email'].includes(field) && !value) {
      bad(field + ' is EMPTY and is required');
      complete = false;
    } else {
      console.log('      ' + field.padEnd(16) + ' ' + (shown === null || shown === undefined ? '(none)' : shown));
    }
  }

  console.log('\n      Next: confirm this organization id is the one you onboarded -');
  console.log('        npm run tenants -- list   ' + DIM + '# broker_org_id must equal '
    + profile.organizationId + OFF);
  console.log('      and that the email domain is verified for that tenant.');
  return complete;
}

async function main() {
  const args = process.argv.slice(2);
  const codeArg = args.find((a) => a.startsWith('--code=')) || '';
  const code = codeArg.split('=')[1];

  if (config.sso.provider !== 'workos') {
    console.log('\nSSO_PROVIDER is "' + config.sso.provider + '", not "workos".');
    console.log('This checks the REAL integration. Set SSO_PROVIDER=workos and the');
    console.log('WORKOS_* variables, then run it again.\n');
    process.exit(2);
  }

  let good = await checkConfig();
  if (good) good = await checkCredentials();
  if (good && code) good = await checkExchange(code);

  if (good && !code) {
    console.log('\n' + DIM + 'Credentials verified. The response SHAPE is still unverified -' + OFF);
    console.log(DIM + 're-run with --code=<code from a real sign-in> to check it.' + OFF);
  }
  console.log(good ? '\n' + GREEN + 'Preflight passed.' + OFF + '\n'
    : '\n' + RED + 'Preflight failed.' + OFF + '\n');
  process.exit(good ? 0 : 1);
}

module.exports = { checkConfig, checkCredentials, checkExchange };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
