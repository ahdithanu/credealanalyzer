'use strict';

/**
 * The security event log and the CSP violation collector.
 *
 * These two exist to feed the CloudWatch alarms in infra/lib/platform.js, and
 * that makes them a particular kind of fragile: a metric filter matches a
 * literal field name, so a rename here silently turns an alarm into decoration.
 * The alarm does not break. It simply never fires again, and the first time
 * anyone finds out is during the incident it was meant to catch.
 *
 * So these tests assert the exact field names and the exact `kind` strings, and
 * infra/test/synth.test.js asserts the deployed filters match the same ones.
 * Break either side and one of the two suites goes red.
 *
 * Runs against no database: everything here is in-process.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.SSO_PROVIDER = 'stub';
process.env.APP_ORIGIN = 'http://localhost:3000';

const { securityEvent, emailDomain, KIND, MAX_FIELD } = require('../src/obs/securityLog');
const csp = require('../src/routes/cspReport');
const { createApp } = require('../src/app');

/** Capture the lines securityEvent writes, so they can be asserted on. */
function capture(fn) {
  const lines = [];
  const original = console.error;
  console.error = (s) => { lines.push(s); };
  try { return { result: fn(), lines }; } finally { console.error = original; }
}
async function captureAsync(fn) {
  const lines = [];
  const original = console.error;
  console.error = (s) => { lines.push(s); };
  try { await fn(); } finally { console.error = original; }
  return lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o && o.evt === 'security');
}

let server, base;
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

const post = (body, contentType = 'application/csp-report') => fetch(`${base}/csp-report`, {
  method: 'POST',
  headers: { 'content-type': contentType },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// ─── the log line's shape ────────────────────────────────────────────────────

test('every event carries the evt discriminator the metric filters key on', () => {
  const { lines } = capture(() => securityEvent(KIND.CSRF_REJECTED, { tenant: 't1' }));
  const parsed = JSON.parse(lines[0]);
  // If this ever stops being 'security', every filter in platform.js matches
  // nothing and every alarm goes permanently, invisibly quiet.
  assert.equal(parsed.evt, 'security');
  assert.equal(parsed.kind, 'csrf_rejected');
  assert.equal(parsed.tenant, 't1');
  assert.ok(Date.parse(parsed.at) > 0, 'timestamp must be parseable');
});

test('the kind strings are exactly what the alarms match', () => {
  // Spelled out rather than derived from KIND, so that renaming a constant does
  // not rename the expectation along with it. These strings are a contract with
  // infra/lib/platform.js and changing one requires changing both.
  assert.deepEqual(KIND, {
    SESSION_REJECTED: 'session_rejected',
    CSRF_REJECTED: 'csrf_rejected',
    ORIGIN_REJECTED: 'origin_rejected',
    ROLE_DENIED: 'role_denied',
    LOGIN_FAILED: 'login_failed',
    SCIM_AUTH_FAILED: 'scim_auth_failed',
    RATE_LIMITED: 'rate_limited',
    MFA_FAILED: 'mfa_failed',
    MFA_FAILOPEN: 'mfa_failopen',
    CSP_VIOLATION: 'csp_violation',
    SERVER_ERROR: 'server_error',
  });
});

test('an attacker cannot forge a second log line through a field', () => {
  // The sample in a CSP report is attacker-chosen text. If it reached the log
  // unescaped, a newline plus a crafted JSON object would appear to CloudWatch
  // as a separate event — which is how you manufacture a false alarm, or bury a
  // real one under a hundred fabricated ones.
  const { lines } = capture(() => securityEvent(KIND.CSP_VIOLATION, {
    sample: '{"evt":"security","kind":"forged"}',
  }));
  assert.equal(lines.length, 1, 'one call must produce exactly one line');
  assert.ok(!lines[0].includes('\n'), 'no raw newline may reach the log');
  assert.equal(JSON.parse(lines[0]).kind, 'csp_violation');
});

test('a field cannot be used to bloat the log group', () => {
  const { lines } = capture(() => securityEvent(KIND.ORIGIN_REJECTED, {
    origin: 'https://evil.example/'.padEnd(50_000, 'a'),
  }));
  assert.ok(lines[0].length < 1000, `line was ${lines[0].length} bytes`);
  assert.equal(JSON.parse(lines[0]).origin.length, MAX_FIELD + 1, 'capped, with the ellipsis');
});

test('emailDomain keeps the domain and drops the person', () => {
  assert.equal(emailDomain('Analyst.Name@FirmX.com'), 'firmx.com');
  // Not an address: returns null rather than putting the raw string in a field
  // labelled "domain", which would be a small lie an operator would act on.
  assert.equal(emailDomain('not-an-address'), null);
  assert.equal(emailDomain('a@b'), null);
  assert.equal(emailDomain(undefined), null);
  // The local part must not survive anywhere in the line.
  const { lines } = capture(() => securityEvent(KIND.LOGIN_FAILED, {
    code: 'domain_not_verified', domain: emailDomain('jane.doe@firmx.com'),
  }));
  assert.ok(!lines[0].includes('jane.doe'), 'the local part is PII and must not be logged');
  assert.ok(lines[0].includes('firmx.com'));
});

// ─── the collector ───────────────────────────────────────────────────────────

test('a CSP Level 2 report is collected', async () => {
  csp.__reset();
  const events = await captureAsync(() => post({
    'csp-report': {
      'document-uri': 'https://app.example/pipeline',
      'violated-directive': "script-src 'self'",
      'blocked-uri': 'https://evil.example/inject.js',
      'script-sample': 'alert(1)',
    },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'csp_violation');
  assert.equal(events[0].blockedURI, 'https://evil.example/inject.js');
  assert.equal(events[0].directive, "script-src 'self'");
  assert.equal(events[0].disposition, 'enforce');
});

test('a Reporting API report is collected, and non-CSP reports are not', async () => {
  csp.__reset();
  // Chrome sends this shape. Handling only the Level 2 shape would mean
  // collecting nothing at all from the browser most analysts use, while the
  // endpoint looked perfectly healthy.
  const events = await captureAsync(() => post([
    { type: 'csp-violation', body: { documentURI: 'https://app.example/', effectiveDirective: 'connect-src', blockedURI: 'https://exfil.example' } },
    { type: 'deprecation', body: { id: 'SomeApi' } },
  ], 'application/reports+json'));
  assert.equal(events.length, 1, 'the deprecation report is not a security event');
  assert.equal(events[0].directive, 'connect-src');
  assert.equal(events[0].blockedURI, 'https://exfil.example');
});

test('repeat reports of the same violation are suppressed', async () => {
  csp.__reset();
  const body = { 'csp-report': { 'violated-directive': "script-src 'self'", 'blocked-uri': 'https://evil.example/a.js' } };
  const first = await captureAsync(() => post(body));
  const second = await captureAsync(() => post(body));
  assert.equal(first.length, 1);
  // One injected script blocked on a hundred deal pages is one event. Without
  // this, a single persistent violation writes a line per page load per browser
  // and the alarm's "unusual volume" threshold becomes meaningless.
  assert.equal(second.length, 0, 'the duplicate must not be emitted');
});

test('a different violation is not suppressed by the first', async () => {
  csp.__reset();
  await captureAsync(() => post({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://a.example/x.js' } }));
  const events = await captureAsync(() => post({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://b.example/y.js' } }));
  assert.equal(events.length, 1, 'suppression must be per violation, not global');
});

test('junk cannot manufacture a security event', async () => {
  csp.__reset();
  // The endpoint is unauthenticated and internet-facing. Without the
  // directive check, anyone able to POST JSON could write alarm-bearing lines
  // into our log group at will.
  for (const body of [{ hello: 'world' }, { 'csp-report': {} }, [], [{ type: 'csp-violation' }]]) {
    const events = await captureAsync(() => post(body, 'application/json'));
    assert.equal(events.length, 0, `${JSON.stringify(body)} produced an event`);
  }
});

test('the collector answers 204 to everything and reveals nothing', async () => {
  csp.__reset();
  const cases = [
    ['a valid report', { 'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': 'data:' } }, 'application/csp-report'],
    ['unparseable', 'this is not json', 'application/csp-report'],
    ['junk object', { a: 1 }, 'application/json'],
    ['oversized', { 'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'z'.repeat(20_000) } }, 'application/csp-report'],
  ];
  for (const [label, body, ct] of cases) {
    const res = await post(body, ct);
    // A 400 on a malformed body would tell a prober what this accepts; a
    // browser has nothing to do with the answer either way.
    assert.equal(res.status, 204, `${label} answered ${res.status}`);
    assert.equal(await res.text(), '', `${label} returned a body`);
  }
});

test('an oversized report is rejected before it is logged', async () => {
  csp.__reset();
  const events = await captureAsync(() => post({
    'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'z'.repeat(20_000) },
  }));
  // The 8KB parser limit is what stops attacker-chosen text being parsed at
  // all. Relying on the per-field cap alone would still mean parsing it.
  assert.equal(events.length, 0, 'a body over the limit must not reach the logger');
});
