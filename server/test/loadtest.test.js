'use strict';

/**
 * The load test's own verdict.
 *
 * Testing a load test looks like ceremony until you have watched one report a
 * pass on a run that measured nothing. This one did, on its first execution:
 * 62,719 requests, 62,124 of them rejected by the rate limiter in microseconds
 * without reaching the database, p99 of 17.5ms, no server errors — PASSED.
 * Every number was true. The conclusion was worthless, and a green result from
 * a tool that looked at nothing is the same failure as an alarm keyed on a
 * pattern nothing emits.
 *
 * So the verdict logic is separated from the network and pinned here. No
 * database and no server: these are the arithmetic and the judgement.
 */

const test = require('node:test');
const assert = require('node:assert');
const { summarise, percentile, THRESHOLDS } = require('../src/admin/loadtest');

/** n samples of a given latency, as the runner collects them. */
const flat = (n, ms) => Array.from({ length: n }, () => ms);
const counts = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));

test('the throttled run that started all this does NOT pass', () => {
  // The real numbers from the first execution, replayed.
  const r = summarise(
    [...flat(595, 8), ...flat(62124, 2)],
    counts({ 200: 482, 201: 113, 429: 62124 }),
    20,
  );
  assert.equal(r.throttled, 62124);
  assert.ok(r.p99 < THRESHOLDS.p99Ms, 'the latency really was excellent');
  assert.equal(r.serverErrors, 0, 'and there really were no errors');
  // And none of that means anything, because 99% of it was a rejection.
  assert.equal(r.inconclusive, true);
  assert.equal(r.passed, false, 'a run that measured the limiter reported a pass');
  // Not FAILED either: nothing was shown to be wrong. A tool that cries failure
  // at a healthy system gets ignored as fast as one that cries success.
  assert.deepEqual(r.failures, []);
});

test('a clean run passes', () => {
  const r = summarise(
    [...flat(2898, 130), ...flat(732, 210)],
    counts({ 200: 2898, 201: 732 }),
    25,
  );
  assert.equal(r.passed, true);
  assert.equal(r.inconclusive, false);
  assert.equal(r.throttled, 0);
  assert.equal(r.perSecond, 145.2);
});

test('a trickle of throttling does not spoil a run', () => {
  // Below the tolerance, the numbers still describe the server. Treating any
  // 429 at all as disqualifying would make the tool unusable against a system
  // that has a limiter — which is every deployment of this one.
  const r = summarise(
    [...flat(3000, 120), ...flat(50, 1)],
    counts({ 200: 3000, 429: 50 }),
    20,
  );
  assert.ok(r.throttledShare < THRESHOLDS.maxThrottledShare);
  assert.equal(r.inconclusive, false);
  assert.equal(r.passed, true);
});

test('a slow tail fails even when the median is fine', () => {
  // The case percentiles exist for: most requests fast and a tail of
  // underwriting saves taking four seconds, which is what pool exhaustion or a
  // database problem actually looks like. The mean here is 178ms and would read
  // as healthy.
  const r = summarise(
    [...flat(3920, 120), ...flat(80, 4000)],   // 2% slow
    counts({ 200: 4000 }),
    20,
  );
  assert.equal(r.p50, 120);
  assert.equal(r.p99, 4000);
  assert.equal(r.passed, false);
  assert.match(r.failures.join(' '), /p99 4000ms exceeds/);
});

test('p99 sits exactly at the boundary when 1% is slow', () => {
  // Written down because getting this wrong is easy and the error is silent: at
  // exactly 1% slow the 99th percentile is the LAST fast sample, so the tail
  // does not show. A tool that reported 4000ms here would be over-reporting,
  // and one asked to catch a 1% tail needs p99.9, not p99.
  const r = summarise(
    [...flat(3960, 120), ...flat(40, 4000)],   // exactly 1% slow
    counts({ 200: 4000 }),
    20,
  );
  assert.equal(r.p99, 120);
  assert.equal(r.max, 4000, 'the tail is still visible in max');
  assert.equal(r.passed, true);
});

test('a single server error fails the run', () => {
  // Zero budget, deliberately. A load test that tolerates a percentage of 5xx
  // has decided in advance that some failures are acceptable, which is not a
  // decision a load test gets to make.
  const r = summarise(flat(10_000, 50), counts({ 200: 9999, 500: 1 }), 20);
  assert.equal(r.serverErrors, 1);
  assert.equal(r.passed, false);
  assert.match(r.failures.join(' '), /1 server errors or dropped connections/);
});

test('a dropped connection counts as a server error, not a fast request', () => {
  // The runner records a thrown fetch as status -1. Swallowing it would turn a
  // crash under load into an unusually quick run.
  const r = summarise(flat(1000, 5), counts({ '-1': 1000 }), 10);
  assert.equal(r.serverErrors, 1000);
  assert.equal(r.passed, false);
});

test('percentiles come from the sorted tail, not the mean', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 99), 99);
  // The worst sample must be reachable: a p99 that silently drops the tail is
  // the statistic this tool exists to avoid.
  assert.equal(percentile(sorted, 100), 100);
  assert.equal(percentile([], 99), null);
});
