'use strict';

const config = require('../config');
const session = require('../auth/session');

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
          res.status(403).json({ error: 'csrf' });
          return;
        }
        // Belt and braces with SameSite=Lax: a cross-site form post arrives
        // with an Origin the browser sets and script cannot forge.
        const origin = req.headers.origin;
        if (origin && origin !== config.appOrigin) {
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
      res.status(403).json({ error: 'forbidden', need: allowed });
      return;
    }
    next();
  };
}

module.exports = { requireSession, requireRole, readCookie };
