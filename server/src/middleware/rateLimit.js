'use strict';

/**
 * In-process rate limiting.
 *
 * The WAF rules in infra/ are the real defence and they only exist once the
 * stack is deployed behind that exact load balancer. Anything else — a local
 * run, a docker-compose demo, a staging box, a future move to another host —
 * has no limiter at all. `/auth/start` is unauthenticated and writes a row per
 * call, so unthrottled it is both free denial of service and a way to fill
 * `sso_states`.
 *
 * DELIBERATELY IN MEMORY, and the consequence is stated rather than hidden:
 * with N tasks a caller gets N times the limit, and a restart forgets
 * everything. A shared store (Redis, or a Postgres table) would be exact and
 * would put a network round trip plus a new failure mode in front of the login
 * path. For a defence-in-depth layer sitting behind a WAF that does the precise
 * counting, approximate and dependency-free is the better trade. If this ever
 * becomes the ONLY limiter in production, replace it.
 */

const buckets = new Map();

/** Sweep expired windows so the map cannot grow without bound. */
function sweep(now) {
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

let lastSweep = 0;

/**
 * @param {object} opts
 * @param {number} opts.limit    requests allowed per window
 * @param {number} opts.windowMs window length
 * @param {string} opts.name     appears in the bucket key, so two limiters on
 *                               the same route do not share a counter
 */
function rateLimit({ limit, windowMs, name }) {
  return (req, res, next) => {
    const now = Date.now();
    // Amortised cleanup rather than a timer: no interval to leak in tests, and
    // no work at all on an idle server.
    if (now - lastSweep > windowMs) { sweep(now); lastSweep = now; }

    // req.ip honours `trust proxy: 1`, so this is the client address from the
    // load balancer's X-Forwarded-For rather than the balancer itself. Trusting
    // the whole chain would let a caller forge the key and evade the limit.
    const key = `${name}:${req.ip || 'unknown'}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;

    const remaining = Math.max(0, limit - b.count);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((b.resetAt - now) / 1000)));

    if (b.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      // No detail about the limit's purpose or the caller's history: a limiter
      // that explains itself is a limiter that helps someone tune around it.
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}

/** Tests only. */
function __reset() { buckets.clear(); lastSweep = 0; }

module.exports = { rateLimit, __reset };
