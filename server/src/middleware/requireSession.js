'use strict';

const config = require('../config');
const session = require('../auth/session');
const { securityEvent, KIND } = require('../obs/securityLog');

/** Read one cookie without pulling in a parser dependency. */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/**
 * Authenticate the request, and attach the session.
 *
 * `req.session.tenantId` is the ONLY tenant any handler may use. Nothing here
 * reads a tenant from the request, and no handler should either — see the note
 * at the top of auth/session.js for what happens if one does.
 */
function requireSession() {
  return async (req, res, next) => {
    try {
      const token = readCookie(req, config.session.cookieName);
      const s = await session.resolve(token);
      if (!s) {
        // Logged, but note what is NOT distinguished here: the response is one
        // answer for absent, expired, revoked and suspended-tenant, and so is
        // the log line. Recording which one it was would put the oracle the
        // response withholds into a place an insider can read.
        //
        // This fires on every anonymous page load, so the alarm on it is a
        // rate, never a presence. `hadCookie` is the discriminator worth
        // having: a rejected request that PRESENTED a cookie is a stale or
        // forged token, and a flood of those is a very different event from a
        // flood of visitors who are simply not signed in yet.
        securityEvent(KIND.SESSION_REJECTED, {
          hadCookie: token !== null,
          ip: req.ip,
          path: req.path,
        });
        // No detail about WHY: absent, expired, revoked and suspended-tenant
        // are one answer to the client. Anything finer is a probing oracle.
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }

      // CSRF, on state-changing methods only. Safe methods are exempt because
      // they change nothing, and requiring a token on them would break plain
      // navigation to the app.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const presented = req.headers['x-csrf-token'];
        if (!session.csrfValid(s.sessionId, Array.isArray(presented) ? presented[0] : presented)) {
          // Unlike a missing session, this is not ordinary traffic. A browser
          // holding a valid session cookie was handed a CSRF token with it; a
          // request that has the first and not the second is either a cross-site
          // forgery attempt or a client so broken it is worth knowing about.
          securityEvent(KIND.CSRF_REJECTED, {
            tenant: s.tenantId,
            user: s.userId,
            presented: presented ? 'invalid' : 'absent',
            method: req.method,
            path: req.path,
            ip: req.ip,
          });
          res.status(403).json({ error: 'csrf' });
          return;
        }
        // Belt and braces with SameSite=Lax: a cross-site form post arrives
        // with an Origin the browser sets and script cannot forge.
        const origin = req.headers.origin;
        if (origin && origin !== config.appOrigin) {
          // The rejected origin IS logged, capped, because it names the site
          // attempting the forgery and that is the one thing an operator needs
          // in order to act. It is attacker-controlled text, which is why it
          // goes through the capping in securityLog rather than straight out.
          securityEvent(KIND.ORIGIN_REJECTED, {
            tenant: s.tenantId,
            user: s.userId,
            origin,
            method: req.method,
            path: req.path,
            ip: req.ip,
          });
          res.status(403).json({ error: 'origin' });
          return;
        }
      }

      // Rotate a long-lived session so a stolen cookie has a short useful life.
      // The old row is revoked, so the stolen copy stops working rather than
      // continuing beside the new one.
      if (session.shouldRotate(s)) {
        const rotated = await session.issue(null, {
          userId: s.userId,
          tenantId: s.tenantId,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        await session.revoke(s.sessionId);
        res.cookie(config.session.cookieName, rotated.token,
          session.cookieOptions(config.session.ttlMs));
        s.sessionId = (await session.resolve(rotated.token)).sessionId;
      }

      req.session = s;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Role gate. Roles are per-tenant, so this is always inside a session. */
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.session) { res.status(401).json({ error: 'unauthenticated' }); return; }
    if (!allowed.includes(req.session.role)) {
      // A known user reaching for something their role does not cover. One is a
      // mis-click; a sustained stream from one user id is someone mapping the
      // edges of their permissions, which is worth a look before it succeeds.
      securityEvent(KIND.ROLE_DENIED, {
        tenant: req.session.tenantId,
        user: req.session.userId,
        role: req.session.role,
        need: allowed.join(','),
        method: req.method,
        path: req.path,
      });
      res.status(403).json({ error: 'forbidden', need: allowed });
      return;
    }
    next();
  };
}

module.exports = { requireSession, requireRole, readCookie };
