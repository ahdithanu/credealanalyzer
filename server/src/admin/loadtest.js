'use strict';

/**
 * Load test.
 *
 * WHAT THIS IS FOR, because "we load tested it" is a claim that usually means
 * somebody pointed a tool at /healthz and watched a large number appear.
 *
 * A health check that returns a constant answers before it touches the
 * database, the session table, the keyring or the audit chain. It measures
 * Express and the event loop. Everything that could actually fall over under
 * load in this system is downstream of it:
 *
 *   - resolving a session is a database round trip on every request;
 *   - saving a deal seals the payload through the tenant's key, writes the row,
 *     writes an audit entry through a hashing trigger, and unseals it again to
 *     answer — four things, in one transaction, holding a pooled connection;
 *   - the pool is 10 connections per task and the tasks autoscale on CPU, which
 *     is the wrong signal if the bottleneck is connections rather than CPU.
 *
 * So this drives the real endpoints through a real SSO login, and reports
 * latency percentiles rather than an average. An average is the statistic that
 * hides the case worth finding: most requests fast and a tail of underwriting
 * saves timing out, which is what pool exhaustion actually looks like.
 *
 * IT FAILS, rather than merely reporting. A load test whose output is a page of
 * numbers is a page of numbers nobody reads twice. Thresholds are declared
 * below, exit code 1 when they are missed.
 *
 * WHAT IT DOES NOT PROVE. It runs from ONE host against ONE process. It
 * therefore says nothing about the load balancer, the WAF's rate limiting,
 * cross-AZ latency, or how RDS behaves with a real working set — and the
 * numbers it produces on a laptop are not a capacity model for Fargate. It is
 * for finding the shape of the bottleneck and for catching a regression that
 * makes a request ten times more expensive, which is the failure that reaches
 * production without anyone noticing.
 *
 *   npm run loadtest -- --duration=30 --concurrency=20
 *
 * Point it at a running stack (docker compose up) with --base.
 */

const DEFAULTS = {
  base: process.env.LOADTEST_BASE || 'http://127.0.0.1:8080',
  duration: 20,
  concurrency: 10,
  // The mix. Weighted towards reads because that is what an analyst does:
  // opens the pipeline, opens a deal, changes an assumption, saves. Writes are
  // the expensive ones and are deliberately over-represented relative to a real
  // session so a regression in the write path shows up in twenty seconds.
  mix: { list: 5, read: 3, write: 2 },
};

/**
 * Thresholds.
 *
 * Chosen to be defensible rather than impressive, and worth reading as a
 * statement of intent: p99 is what a person experiences on their worst save of
 * the afternoon, and three seconds is the point at which someone in an IC
 * meeting starts refreshing the page.
 *
 * The error budget is ZERO for 5xx. A load test that tolerates a percentage of
 * server errors has decided in advance that some failures are acceptable, which
 * is not a decision a load test gets to make.
 */
const THRESHOLDS = {
  p99Ms: 3000,
  p95Ms: 1500,
  serverErrors: 0,
  /**
   * The share of requests that may be rate limited before the run stops being a
   * measurement at all.
   *
   * The first run of this tool sent 62,719 requests, 62,124 of which came back
   * 429, and reported PASSED — p99 of 17ms, no server errors, thresholds met.
   * Every one of those numbers was true and every one described the limiter
   * rejecting a request in microseconds without touching the database. It was a
   * green result from a test that had measured nothing, which is the same
   * failure as an alarm on a pattern nothing emits.
   *
   * So a throttled run is now INCONCLUSIVE rather than passed. Not failed
   * either — nothing was shown to be wrong — and the distinction matters,
   * because a tool that cries failure at a healthy system gets ignored just as
   * fast as one that cries success at a blind one.
   */
  maxThrottledShare: 0.05,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (const arg of argv) {
    const m = /^--([a-zA-Z]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key in out) out[key] = typeof out[key] === 'number' ? Number(value) : value;
  }
  return out;
}

/**
 * Percentiles from raw samples, by sorting.
 *
 * Not a streaming estimator: a twenty-second run is tens of thousands of
 * samples, sorting them is milliseconds, and an approximate p99 from a t-digest
 * would be one more thing to be wrong about in a tool whose whole job is to be
 * trusted about the tail.
 */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

/** Sign in through the stub identity provider and come back with a session. */
async function signIn(base) {
  const jar = [];
  const capture = (res) => {
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) jar.push(c.split(';')[0]);
  };
  const cookie = () => jar.join('; ');

  // /auth/start issues the state and redirects at the identity provider.
  const start = await fetch(`${base}/auth/start?next=/`, { redirect: 'manual' });
  const idp = new URL(start.headers.get('location'), base);
  const state = idp.searchParams.get('state');
  const code = idp.searchParams.get('code') || `load-${Math.random().toString(36).slice(2)}`;

  // The stub IdP's form post. This is the LOCAL path: the stub is registered
  // only when SSO_PROVIDER=stub, and config.js refuses to boot in production
  // with it selected, so this tool cannot be pointed at a real deployment and
  // mint itself an identity.
  const body = new URLSearchParams({
    state, code, email: 'analyst@firmx.com', organization: 'org_firm_x',
  });
  const posted = await fetch(`${base}/auth/stub`, {
    method: 'POST', body, redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const callback = new URL(posted.headers.get('location'), base);
  const done = await fetch(`${base}${callback.pathname}${callback.search}`, { redirect: 'manual' });
  capture(done);
  if (!jar.length) throw new Error('sign-in produced no session cookie');

  const me = await fetch(`${base}/auth/me`, { headers: { cookie: cookie() } });
  if (!me.ok) throw new Error(`/auth/me returned ${me.status} after sign-in`);
  const { csrfToken } = await me.json();
  return { cookie: cookie(), csrfToken };
}

const PAYLOAD = {
  purchasePrice: 24_500_000,
  propertyType: 'multifamily',
  units: 180,
  holdYears: 7,
  exitCapRate: 5.75,
  rentPerUnit: 2150,
  vacancyRate: 5,
  opexPerUnit: 7400,
  ltv: 60,
  interestRate: 6.25,
};

/** One virtual user, looping until the clock runs out. */
async function worker(base, session, until, mix, samples, statuses) {
  const headers = { cookie: session.cookie, 'content-type': 'application/json' };
  const writeHeaders = { ...headers, 'x-csrf-token': session.csrfToken };
  let known = [];

  const weighted = [];
  for (const [op, n] of Object.entries(mix)) for (let i = 0; i < n; i += 1) weighted.push(op);

  while (Date.now() < until) {
    const op = weighted[Math.floor(Math.random() * weighted.length)];
    const started = process.hrtime.bigint();
    let status = 0;
    try {
      if (op === 'list') {
        const res = await fetch(`${base}/api/deals`, { headers });
        status = res.status;
        const body = await res.json().catch(() => null);
        if (body?.deals?.length) known = body.deals.map((d) => d.id);
      } else if (op === 'read' && known.length) {
        const id = known[Math.floor(Math.random() * known.length)];
        const res = await fetch(`${base}/api/deals/${id}`, { headers });
        status = res.status;
        await res.arrayBuffer();
      } else {
        // The expensive one: seal, insert, audit, unseal, all in one
        // transaction holding a pooled connection.
        const res = await fetch(`${base}/api/deals`, {
          method: 'POST',
          headers: writeHeaders,
          body: JSON.stringify({
            name: `Load ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            stage: 'Screening',
            payload: PAYLOAD,
          }),
        });
        status = res.status;
        await res.arrayBuffer();
      }
    } catch (err) {
      // A connection refused or reset is a failure of the system under test and
      // is recorded as one. Swallowing it would turn a crash into a fast run.
      status = -1;
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    samples.push(ms);
    statuses.set(status, (statuses.get(status) || 0) + 1);
  }
}

/**
 * Turn raw samples into the verdict.
 *
 * Split out from run() so it can be tested without a server, which is not
 * ceremony: the verdict logic is where this tool's own bug was. Its first run
 * sent 62,719 requests, had 62,124 of them rejected by the rate limiter without
 * touching the database, and reported PASSED on the strength of a 17ms p99.
 * Every number was true and the conclusion was worthless.
 */
function summarise(samples, statuses, elapsed) {
  const sorted = [...samples].sort((a, b) => a - b);
  const byStatus = [...statuses.entries()].sort((a, b) => a[0] - b[0]);
  const total = samples.length;
  const serverErrors = byStatus
    .filter(([s]) => s >= 500 || s === -1)
    .reduce((n, [, c]) => n + c, 0);
  const throttled = statuses.get(429) || 0;
  const throttledShare = total ? throttled / total : 0;

  const result = {
    requests: total,
    seconds: Number(elapsed.toFixed(1)),
    perSecond: Number((total / elapsed).toFixed(1)),
    p50: Number(percentile(sorted, 50).toFixed(1)),
    p95: Number(percentile(sorted, 95).toFixed(1)),
    p99: Number(percentile(sorted, 99).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
    statuses: Object.fromEntries(byStatus),
    serverErrors,
    throttled,
    throttledShare: Number(throttledShare.toFixed(4)),
  };

  const failures = [];
  if (result.p99 > THRESHOLDS.p99Ms) {
    failures.push(`p99 ${result.p99}ms exceeds ${THRESHOLDS.p99Ms}ms`);
  }
  if (result.p95 > THRESHOLDS.p95Ms) {
    failures.push(`p95 ${result.p95}ms exceeds ${THRESHOLDS.p95Ms}ms`);
  }
  if (serverErrors > THRESHOLDS.serverErrors) {
    failures.push(`${serverErrors} server errors or dropped connections`);
  }

  const inconclusive = throttledShare > THRESHOLDS.maxThrottledShare;
  return {
    ...result,
    failures,
    inconclusive,
    // Neither a throttled run nor a failing one is a pass. A caller that treats
    // "not failed" as "passed" gets the first run's result back.
    passed: !inconclusive && failures.length === 0,
  };
}

function report(result) {
  const byStatus = Object.entries(result.statuses);
  process.stdout.write(`  ${result.requests} requests in ${result.seconds}s `
    + `(${result.perSecond}/s)\n`);
  process.stdout.write(`  p50 ${result.p50}ms   p95 ${result.p95}ms   `
    + `p99 ${result.p99}ms   max ${result.max}ms\n`);
  process.stdout.write(`  statuses ${byStatus.map(([s, c]) => `${s === '-1' ? 'conn-fail' : s}:${c}`).join('  ')}\n`);

  if (result.throttled) {
    // The limiter is keyed on client address and this tool is one address, so
    // reaching the ceiling means the limiter is working — not that the server
    // is slow. What it also means is that the percentiles above describe
    // rejections, which cost microseconds and touch nothing.
    process.stdout.write(`  ${(result.throttledShare * 100).toFixed(1)}% of requests were rate `
      + `limited (${result.throttled}).\n`);
  }

  if (result.inconclusive) {
    process.stdout.write('\nINCONCLUSIVE — this run measured the rate limiter, not the '
      + 'server.\n');
    process.stdout.write('  The limiter is keyed on client address and this tool is one '
      + 'address. The\n  latency above is the cost of being rejected, which is nothing '
      + 'like the cost of\n  serving a request. Raise the ceiling for the measurement:\n\n');
    process.stdout.write('    RATE_LIMIT_GLOBAL=1000000 npm start\n\n');
  } else if (result.failures.length) {
    process.stdout.write('\nFAILED\n');
    for (const f of result.failures) process.stdout.write(`  - ${f}\n`);
    process.stdout.write('\n');
  } else {
    process.stdout.write(`\nPassed: p95 under ${THRESHOLDS.p95Ms}ms, p99 under `
      + `${THRESHOLDS.p99Ms}ms, no server errors.\n\n`);
  }
}

async function run(opts) {
  const { base, duration, concurrency } = opts;
  process.stdout.write(`\nLoad test → ${base}\n`);
  process.stdout.write(`  ${concurrency} concurrent users for ${duration}s\n\n`);

  const session = await signIn(base);

  const samples = [];
  const statuses = new Map();
  const until = Date.now() + duration * 1000;
  const wall = Date.now();
  await Promise.all(Array.from({ length: concurrency },
    () => worker(base, session, until, opts.mix, samples, statuses)));
  const elapsed = (Date.now() - wall) / 1000;

  const result = summarise(samples, statuses, elapsed);
  report(result);
  return result;
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2)))
    // 0 passed, 1 thresholds missed, 3 inconclusive. Distinct codes because a
    // CI job that cannot tell "slow" from "did not measure anything" will treat
    // the second as the first and act on a number that means nothing.
    .then((r) => process.exit(r.passed ? 0 : (r.inconclusive ? 3 : 1)))
    .catch((e) => {
      process.stderr.write(`\nload test could not run: ${e.message}\n\n`);
      process.exit(2);
    });
}

module.exports = { run, summarise, percentile, THRESHOLDS };
