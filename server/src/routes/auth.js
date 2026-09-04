'use strict';

const express = require('express');
const config = require('../config');
const login = require('../auth/login');
const session = require('../auth/session');
const { requireSession } = require('../middleware/requireSession');
const { broker } = require('../auth/broker');

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

  /**
   * The fake identity provider's page. LOCAL DEMOS ONLY.
   *
   * Registered only when the stub provider is active, and config.js refuses to
   * boot in production with the stub selected — so this route cannot exist on a
   * real deployment. Both guards are deliberate: this page mints an identity
   * from a form field, which is a total authentication bypass, and one guard is
   * one mistake away from shipping it.
   *
   * It exists because the stub used to redirect to an unresolvable host, which
   * is right for unit tests and meant nobody could click through a login to see
   * the product work.
   */
  if (config.sso.provider === 'stub' && !config.isProd) {
    r.get('/stub', (req, res) => {
      const { state, code, organization } = req.query;
      const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(`<!doctype html><meta charset="utf-8">
<title>Demo identity provider</title>
<style>
 body{background:#0f111c;color:#e8e9f0;font:14px/1.5 -apple-system,system-ui,sans-serif;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
 .c{background:#171a28;border:1px solid #252938;border-radius:10px;padding:30px;width:360px}
 h1{font-size:16px;margin:0 0 4px} p{color:#8b8fa3;font-size:12px;margin:0 0 18px}
 label{font-size:11px;color:#8b8fa3;display:block;margin-bottom:5px}
 input{width:100%;height:32px;background:#0f111c;border:1px solid #252938;border-radius:5px;
       color:#e8e9f0;padding:0 9px;font:inherit;font-size:13px;box-sizing:border-box}
 button{width:100%;height:34px;margin-top:16px;background:#9184d9;border:0;border-radius:5px;
        color:#fff;font:inherit;font-size:13px;font-weight:500;cursor:pointer}
 .w{margin-top:18px;padding-top:14px;border-top:1px solid #252938;font-size:11px;color:#8b8fa3}
</style>
<div class="c">
 <h1>Demo identity provider</h1>
 <p>Stands in for Okta, Entra ID or Google Workspace.</p>
 <form method="POST" action="/auth/stub">
  <input type="hidden" name="state" value="${esc(state)}">
  <input type="hidden" name="code" value="${esc(code)}">
  <label for="e">Email address</label>
  <input id="e" name="email" value="analyst@firmx.com" autocomplete="off" spellcheck="false">
  <label for="o" style="margin-top:12px">Organization</label>
  <input id="o" name="organization" value="${esc(organization || 'org_firm_x')}" spellcheck="false">
  <button type="submit">Sign in</button>
 </form>
 <div class="w">This page mints an identity from a form field. It is registered
 only when SSO_PROVIDER=stub and never in production.</div>
</div>`);
    });

    r.post('/stub', express.urlencoded({ extended: false }), (req, res) => {
      const { state, code, email, organization } = req.body;
      // Stage what the fake IdP asserts, then hand the browser back to the real
      // callback — which runs every check a live provider's callback runs:
      // single-use state, provisioned tenant, verified domain.
      broker().__setProfile(code, {
        organizationId: organization,
        email,
        emailVerified: true,
        externalId: `stub|${email}`,
        name: email.split('@')[0],
        connectionId: 'conn_stub',
        idpName: 'DemoIdP',
      });
      const u = new URL('/auth/callback', config.sso.stubBase);
      u.searchParams.set('state', state);
      u.searchParams.set('code', code);
      res.redirect(302, u.toString());
    });
  }

  return r;
}

module.exports = { authRoutes };
