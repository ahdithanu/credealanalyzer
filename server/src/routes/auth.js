'use strict';

const express = require('express');
const config = require('../config');
const login = require('../auth/login');
const session = require('../auth/session');
const { requireSession } = require('../middleware/requireSession');

/**
 * Authentication routes.
 *
 * The browser is redirected through the identity provider and comes back here.
 * No password is ever seen by this application, which is most of the point of
 * SSO: there is no credential here to leak, and offboarding in the firm's
 * directory offboards them here.
 */
function authRoutes() {
  const r = express.Router();

  // Start a login. GET, because it is a plain navigation from a link or form.
  r.get('/start', async (req, res, next) => {
    try {
      const { url } = await login.begin({
        tenantHint: req.query.org,
        redirectTo: req.query.next,
        ip: req.ip,
      });
      res.redirect(302, url);
    } catch (err) { next(err); }
  });

  // The identity provider returns the browser here.
  r.get('/callback', async (req, res, next) => {
    try {
      const { code, state } = req.query;
      const result = await login.complete({
        state, code, ip: req.ip, userAgent: req.headers['user-agent'],
      });
      res.cookie(config.session.cookieName, result.token,
        session.cookieOptions(config.session.ttlMs));
      // Back into the SPA. `redirectTo` was constrained to a relative path when
      // the handshake began, so this cannot be turned into an open redirect.
      res.redirect(302, new URL(result.redirectTo, config.appOrigin).toString());
    } catch (err) {
      if (err instanceof login.LoginError) {
        // The reason reaches the user as a code the SPA renders, never as a
        // stack trace and never echoing anything from the provider's response.
        const u = new URL('/signin', config.appOrigin);
        u.searchParams.set('error', err.code);
        res.redirect(302, u.toString());
        return;
      }
      next(err);
    }
  });

  // Who am I. The SPA calls this on load to decide whether to show the app.
  r.get('/me', requireSession(), (req, res) => {
    const s = req.session;
    res.json({
      user: { id: s.userId, email: s.email, name: s.name, role: s.role },
      tenant: s.tenant,
      // Handed over here so the SPA can echo it on writes. Safe to expose to
      // the legitimate page and unforgeable without the server key.
      csrfToken: session.csrfToken(s.sessionId),
      expiresAt: s.expiresAt,
    });
  });

  r.post('/logout', requireSession(), async (req, res, next) => {
    try {
      await session.revoke(req.session.sessionId);
      res.clearCookie(config.session.cookieName, session.cookieOptions(0));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return r;
}

module.exports = { authRoutes };
