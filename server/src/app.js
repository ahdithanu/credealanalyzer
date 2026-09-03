'use strict';

const express = require('express');
const config = require('./config');
const { authRoutes } = require('./routes/auth');
const { dealRoutes } = require('./routes/deals');
const { requireSession } = require('./middleware/requireSession');

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

  app.use(express.json({ limit: '1mb' }));

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

  app.use('/auth', authRoutes());
  app.use('/api/deals', requireSession(), dealRoutes());

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
    res.status(status).json({ error: status >= 500 ? 'internal' : (err.code || 'error') });
  });

  return app;
}

module.exports = { createApp };
