'use strict';

const express = require('express');
const config = require('./config');
const { authRoutes } = require('./routes/auth');
const { dealRoutes } = require('./routes/deals');
const { auditRoutes } = require('./routes/audit');
const { exportRoutes } = require('./routes/export');
const { scimRoutes } = require('./routes/scim');
const { requireSession } = require('./middleware/requireSession');
const { rateLimit } = require('./middleware/rateLimit');
const { cspReportRoutes } = require('./routes/cspReport');
const { securityEvent, KIND } = require('./obs/securityLog');

/**
 * The API.
 *
 * Behind an ALB with AWS WAF in front (see infra/), which handles rate limiting
 * and the common injection signatures. This process is responsible for the
 * things a WAF cannot know: who the caller is, which tenant they belong to, and
 * what they are allowed to do.
 */
function createApp() {
  const app = express();

  // Trust the ALB's X-Forwarded-For so req.ip is the client, not the load
  // balancer. Exactly one hop: trusting the whole chain lets a caller forge the
  // address that lands in the audit log.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    // The SPA is served from CloudFront, a different origin, so it needs CORS
    // WITH credentials — which the browser only permits against an exact
    // origin, never a wildcard. That constraint is a feature: there is no way
    // to accidentally open this to every site.
    const origin = req.headers.origin;
    if (origin && origin === config.appOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-csrf-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    // This API returns JSON and never HTML, so the browser should never be
    // persuaded to treat a response as a document.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /**
   * SCIM, mounted AHEAD of the body parser, the global limiter and the cookie
   * shim — every one of which is built for a browser talking to the SPA.
   *
   * A directory is not a browser. It sends `application/scim+json`, which the
   * parser below does not claim; it holds a bearer token rather than a cookie;
   * and it calls from an egress address SHARED WITH EVERY OTHER CUSTOMER of
   * that directory, which is what makes the global limiter wrong here rather
   * than merely redundant — keyed by address, one firm's bulk import would
   * throttle an unrelated firm's deprovisioning. The router brings its own
   * parser and its own limiter keyed on the token; see routes/scim.js.
   *
   * The trade is stated rather than hidden: these routes sit outside the broad
   * ceiling, so their own limiter is the only one in front of them.
   */
  app.use('/scim/v2', scimRoutes());

  /**
   * CSP violation reports, mounted ahead of the body parser for the same class
   * of reason as SCIM: the global `express.json({ limit: '1mb' })` below claims
   * `application/json`, and a browser that posts a report with that content
   * type would have an 8KB-worth of attacker-chosen text parsed under a 1MB
   * ceiling before this router ever saw it. Mounted here, the router's own 8KB
   * parser is the first and only one to touch the body.
   *
   * It sits outside the global limiter too, and carries its own tighter one.
   * See routes/cspReport.js for why an unauthenticated collector gets the
   * narrowest treatment in the application.
   */
  app.use('/csp-report', cspReportRoutes());

  app.use(express.json({ limit: '1mb' }));

  // A broad ceiling across everything, so a single client cannot saturate the
  // pool even on authenticated routes. Generous enough that ordinary use — the
  // sensitivity screen runs many models per interaction — never reaches it.
  app.use(rateLimit({ name: 'global', limit: 600, windowMs: 60_000 }));

  // Minimal cookie setter, so express-cookie is not a dependency.
  app.use((req, res, next) => {
    res.cookie = (name, value, opts = {}) => {
      const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || '/'}`];
      if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
      if (opts.httpOnly) bits.push('HttpOnly');
      if (opts.secure) bits.push('Secure');
      if (opts.sameSite) bits.push(`SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`);
      const prev = res.getHeader('Set-Cookie');
      const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
      res.setHeader('Set-Cookie', [...list, bits.join('; ')]);
      return res;
    };
    res.clearCookie = (name, opts = {}) => res.cookie(name, '', { ...opts, maxAge: 0 });
    next();
  });

  // Unauthenticated: for the load balancer. Deliberately reveals nothing about
  // build, version or database state — a health endpoint is internet-facing.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // The auth path is limited harder than the rest: it is the only
  // unauthenticated surface that touches the database, and every call to
  // /auth/start writes a row.
  app.use('/auth', rateLimit({ name: 'auth', limit: 30, windowMs: 60_000 }), authRoutes());
  app.use('/api/deals', requireSession(), dealRoutes());
  app.use('/api/audit', requireSession(), auditRoutes());
  // Limited far harder than the rest, and limited BEFORE the session lookup so
  // a flood costs no database work. One call reads every row the tenant owns
  // and holds a pooled connection for the length of the transfer; the ordinary
  // use is a handful of times a year, when a firm asks for its archive or an
  // auditor asks for evidence. Anything approaching this ceiling is not that.
  app.use('/api/export',
    rateLimit({ name: 'export', limit: 5, windowMs: 60_000 }),
    requireSession(), exportRoutes());

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    // Log the detail; return a code. A stack trace or a driver message in the
    // response body tells an attacker the schema, the driver and the paths.
    console.error(JSON.stringify({
      level: 'error', msg: err.message, status,
      path: req.path, tenant: req.session?.tenantId || null,
    }));
    // A second, narrower line for the 5xx case only, so the alarm counts
    // genuine faults rather than every 4xx a client earns for itself. The two
    // lines are not redundant: the one above carries the driver's message and
    // is for a human reading logs; this one carries no free text at all and is
    // what a metric filter counts.
    if (status >= 500) {
      securityEvent(KIND.SERVER_ERROR, {
        status, path: req.path, tenant: req.session?.tenantId || null,
      });
    }
    res.status(status).json({ error: status >= 500 ? 'internal' : (err.code || 'error') });
  });

  return app;
}

module.exports = { createApp };
