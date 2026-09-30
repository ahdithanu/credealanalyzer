'use strict';

const test = require('node:test');
const assert = require('node:assert');

/**
 * The deploy preflight.
 *
 * Every check it makes corresponds to a way `cdk deploy` fails LATE — after
 * CloudFormation has started changing things — so the value is entirely in
 * catching them before the first API call. These tests drive it with a fake
 * `aws` and `docker` so every branch runs without an account.
 */

let mod;
test.before(async () => { mod = await import('../preflight.mjs'); });

/** A fake exec: answers from a map of "cmd arg arg" prefix → stdout, or throws. */
function fakeExec(routes) {
  const calls = [];
  return Object.assign(async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const hit = Object.entries(routes).find(([prefix]) => line.includes(prefix));
    if (!hit) throw new Error(`command failed: ${line}`);
    if (hit[1] instanceof Error) throw hit[1];
    return { stdout: hit[1] };
  }, { calls });
}

const sink = () => {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
};

const CERT = (status, domain) => JSON.stringify({ Certificate: { Status: status, DomainName: domain } });

const HEALTHY = {
  'sts get-caller-identity': JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/ahdi' }),
  'configure get region': 'us-east-2\n',
  'acm describe-certificate': CERT('ISSUED', 'api.example.com'),
  'cloudformation describe-stacks': JSON.stringify({ Stacks: [{ StackName: 'CDKToolkit' }] }),
  'docker info': '27.1.1\n',
};

const GOOD_CONTEXT = {
  tier: 'lean',
  apiCertArn: 'arn:aws:acm:us-east-2:123456789012:certificate/aaa',
  webCertArn: 'arn:aws:acm:us-east-1:123456789012:certificate/bbb',
  alertEmail: 'ops@example.com',
};

test('a correct setup passes', async () => {
  const out = sink();
  const { ok } = await mod.preflight(GOOD_CONTEXT, { exec: fakeExec(HEALTHY), log: out });
  assert.equal(ok, true);
  assert.match(out.text(), /Ready to deploy/);
});

test('a web certificate outside us-east-1 is blocking', async () => {
  /**
   * The headline failure. ACM issues it, CDK accepts the ARN, and CloudFront
   * rejects it after the rest of the stack is up — so without this check the
   * feedback arrives twenty minutes in and looks like a CloudFront bug.
   */
  const out = sink();
  const { ok } = await mod.preflight(
    { ...GOOD_CONTEXT, webCertArn: 'arn:aws:acm:eu-west-1:123456789012:certificate/bbb' },
    { exec: fakeExec(HEALTHY), log: out },
  );
  assert.equal(ok, false);
  assert.match(out.text(), /CloudFront reads certificates only from us-east-1/);
  assert.match(out.text(), /eu-west-1/);
});

test('a certificate that is not ISSUED is blocking', async () => {
  // It deploys, and then serves nothing.
  const out = sink();
  const { ok } = await mod.preflight(GOOD_CONTEXT, {
    exec: fakeExec({ ...HEALTHY, 'acm describe-certificate': CERT('PENDING_VALIDATION', 'api.example.com') }),
    log: out,
  });
  assert.equal(ok, false);
  assert.match(out.text(), /PENDING_VALIDATION/);
});

test('a missing apiCertArn is blocking, because the stack refuses to synthesize', async () => {
  const out = sink();
  const { ok } = await mod.preflight({ ...GOOD_CONTEXT, apiCertArn: undefined },
    { exec: fakeExec(HEALTHY), log: out });
  assert.equal(ok, false);
  assert.match(out.text(), /plaintext HTTP/);
});

test('no bootstrap is blocking', async () => {
  const routes = { ...HEALTHY };
  delete routes['cloudformation describe-stacks'];
  const out = sink();
  const { ok } = await mod.preflight(GOOD_CONTEXT, { exec: fakeExec(routes), log: out });
  assert.equal(ok, false);
  assert.match(out.text(), /cdk bootstrap/);
});

test('docker not running is blocking, because the image is built mid-deploy', async () => {
  const routes = { ...HEALTHY };
  delete routes['docker info'];
  const out = sink();
  const { ok } = await mod.preflight(GOOD_CONTEXT, { exec: fakeExec(routes), log: out });
  assert.equal(ok, false);
  assert.match(out.text(), /docker is not running/);
});

test('no credentials is blocking', async () => {
  const routes = { ...HEALTHY };
  delete routes['sts get-caller-identity'];
  const out = sink();
  const { ok } = await mod.preflight(GOOD_CONTEXT, { exec: fakeExec(routes), log: out });
  assert.equal(ok, false);
  assert.match(out.text(), /aws configure/);
});

test('a missing alertEmail warns but does not block', async () => {
  // Every alarm still deploys and still evaluates. Nobody is told.
  const out = sink();
  const { ok } = await mod.preflight({ ...GOOD_CONTEXT, alertEmail: undefined },
    { exec: fakeExec(HEALTHY), log: out });
  assert.equal(ok, true);
  assert.match(out.text(), /notify nobody/);
});

test('an unknown tier is blocking, matching the stack', async () => {
  const out = sink();
  const { ok } = await mod.preflight({ ...GOOD_CONTEXT, tier: 'cheap' },
    { exec: fakeExec(HEALTHY), log: out });
  assert.equal(ok, false);
});

test('it reports EVERY problem, not just the first', async () => {
  // A preflight that stops at the first failure costs one round trip per
  // problem, and the operator fixes certificates, reruns, then finds docker.
  const out = sink();
  await mod.preflight(
    { ...GOOD_CONTEXT, webCertArn: 'arn:aws:acm:eu-west-1:1:certificate/b' },
    { exec: fakeExec({ 'sts get-caller-identity': HEALTHY['sts get-caller-identity'] }), log: out },
  );
  const text = out.text();
  for (const expected of [/us-east-1/, /cdk bootstrap/, /docker is not running/]) {
    assert.match(text, expected);
  }
});

test('it changes nothing', async () => {
  // Read-only by construction: assert no verb that mutates ever runs.
  const exec = fakeExec(HEALTHY);
  await mod.preflight(GOOD_CONTEXT, { exec, log: sink() });
  for (const line of exec.calls) {
    assert.ok(!/\b(create|delete|update|put|deploy|run-task|modify)\b/.test(line),
      `preflight ran a mutating command: ${line}`);
  }
});

test('context parsing accepts every form cdk does', () => {
  const ctx = mod.parseContext([
    '-c', 'tier=lean', '--context', 'apiDomain=api.example.com',
    '-cwebCertArn=arn:aws:acm:us-east-1:1:certificate/x',
    '--context=alertEmail=ops@example.com',
  ]);
  assert.equal(ctx.tier, 'lean');
  assert.equal(ctx.apiDomain, 'api.example.com');
  assert.equal(ctx.webCertArn, 'arn:aws:acm:us-east-1:1:certificate/x');
  assert.equal(ctx.alertEmail, 'ops@example.com');
});

test('an ARN region is read from the ARN, not asked of AWS', () => {
  // Describing a certificate requires knowing its region, which is the thing
  // in question — so the region has to come from the ARN itself.
  assert.equal(mod.arnRegion('arn:aws:acm:us-west-2:1:certificate/x'), 'us-west-2');
  assert.equal(mod.arnRegion('not-an-arn'), null);
  assert.equal(mod.arnRegion(''), null);
});
