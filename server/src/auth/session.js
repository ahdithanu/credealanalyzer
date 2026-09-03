'use strict';

const crypto = require('crypto');
const config = require('../config');
const { authPool } = require('../db/pool');

/**
 * Sessions.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the tenant of a request is whatever the
 * session row says, and nothing else. Not a header, not a query parameter, not
 * a field in the body, not a subdomain the client can spoof, and not a tenant
 * id the SPA remembered. Every one of those is attacker-controlled, and any one
 * of them treated as authoritative turns the row level security in
 * 001_tenancy.sql into decoration — the database faithfully isolates whichever
 * tenant it was told, and it was told by the attacker.
 *
 * Sessions are server-side so they can be REVOKED: offboarding an analyst who
 * has seen a client's pipeline must take effect now, not whenever a
 * self-contained token happens to expire.
 *
 * Only a HASH of the token is stored. A dump of the sessions table — a leaked
 * backup, an over-broad support query — then contains nothing an attacker can
 * present as a live session.
 */

const TOKEN_BYTES = 32;

const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest();

/** Constant-time compare, so a timing signal cannot be used to guess a token. */
function safeEqual(a, b) {
  const A = Buffer.from(a || '', 'utf8');
  const B = Buffer.from(b || '', 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/**
 * Issue a session for a user who has JUST completed an SSO handshake.
 *
 * `tenantId` must be the one resolved from the identity provider's assertion,
 * not one the browser asked for.
 */
async function issue(_unusedDb, { userId, tenantId, ip, userAgent }) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + config.session.ttlMs);
  // On the AUTH pool, not the caller's tenant transaction: app_user has no
  // grant on `sessions` since migration 002. The consequence is that issuing a
  // session is not atomic with the user provisioning that precedes it — if this
  // fails, the user row exists without a session and the person simply signs in
  // again. That is the right way round: the alternative is giving the
  // tenant-data role the power to mint sessions.
  await authPool.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashToken(token), userId, tenantId, expiresAt, ip || null, (userAgent || '').slice(0, 500)],
  );
  return { token, expiresAt };
}

/**
 * Resolve a bearer cookie to a live session, or null.
 *
 * Deliberately UNSCOPED: this runs before any tenant is known — discovering the
 * tenant is the whole point — so it cannot go through withTenant(). It is the
 * one read that legitimately crosses the boundary, which is why it lives here
 * and reads nothing but the session row and its user.
 */
async function resolve(token) {
  if (!token) return null;
  const { rows } = await authPool.query(
    `SELECT s.id, s.user_id, s.tenant_id, s.issued_at, s.expires_at, s.revoked_at,
            u.email, u.name, u.role,
            t.slug AS tenant_slug, t.name AS tenant_name, t.status AS tenant_status
       FROM sessions s
       JOIN users   u ON u.id = s.user_id
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  const s = rows[0];
  if (!s) return null;
  if (s.revoked_at) return null;
  if (new Date(s.expires_at) <= new Date()) return null;
  // A suspended tenant (non-payment, offboarding, a security hold) must lose
  // access immediately, without needing every session revoked one by one.
  if (s.tenant_status !== 'active') return null;

  return {
    sessionId: s.id,
    userId: s.user_id,
    tenantId: s.tenant_id,
    email: s.email,
    name: s.name,
    role: s.role,
    tenant: { id: s.tenant_id, slug: s.tenant_slug, name: s.tenant_name },
    issuedAt: new Date(s.issued_at),
    expiresAt: new Date(s.expires_at),
  };
}

async function revoke(sessionId) {
  await authPool.query(
    'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  );
}

/** Every session for a user — offboarding, or a suspected compromise. */
async function revokeAllForUser(userId) {
  const { rowCount } = await authPool.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  return rowCount;
}

/**
 * Cookie attributes, in one place so no route can set a weaker variant.
 *
 * httpOnly   — script cannot read it, so an XSS bug cannot exfiltrate the
 *              session outright.
 * secure     — never sent over plaintext. Relaxed only when not production,
 *              because localhost has no certificate and a developer who cannot
 *              log in locally will reach for something worse.
 * sameSite   — Lax, NOT Strict, and this is a real trade-off rather than an
 *              oversight: the SSO callback is a top-level cross-site GET back
 *              from the identity provider, and Strict withholds the cookie on
 *              it, so the user completes login and lands logged out. Lax still
 *              withholds it from cross-site POSTs, which is the CSRF vector
 *              that matters, and the CSRF token below covers the rest.
 * path       — the whole API; a narrower path would silently skip routes.
 */
function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(0, Math.floor(maxAgeMs / 1000)) * 1000,
  };
}

/**
 * A CSRF token bound to the session, for the double-submit pattern: the SPA
 * echoes it in a header, and a cross-site form post cannot read it to do so.
 *
 * Derived by HMAC from the session id rather than stored, so it needs no extra
 * table and cannot drift out of sync with the session it protects. It is NOT
 * secret from the legitimate page — that is the point — but it is unforgeable
 * without the server key.
 */
function csrfToken(sessionId) {
  return crypto.createHmac('sha256', config.session.signingSecret)
    .update(`csrf:${sessionId}`)
    .digest('base64url');
}

const csrfValid = (sessionId, presented) => safeEqual(csrfToken(sessionId), presented);

/** True when the session is old enough to be worth replacing. */
const shouldRotate = (session) =>
  Date.now() - session.issuedAt.getTime() > config.session.rotateAfterMs;

module.exports = {
  issue, resolve, revoke, revokeAllForUser,
  cookieOptions, csrfToken, csrfValid, shouldRotate,
  __internals: { hashToken, safeEqual },
};
