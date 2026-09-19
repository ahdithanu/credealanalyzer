'use strict';

/**
 * Configuration, validated at startup.
 *
 * Every value that protects something fails FAST and LOUD when it is missing in
 * production. A server that boots with an empty signing secret, or with cookies
 * that are not Secure, is worse than one that refuses to boot: it looks like it
 * is working. In AWS these arrive from Secrets Manager via the task definition,
 * never from a file in the image.
 */

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
};

const isProd = process.env.NODE_ENV === 'production';

// 32 bytes minimum. Shorter keys are accepted by HMAC and give less security
// than the construction implies, which is exactly the kind of quiet weakening
// worth refusing outright.
function secret(name) {
  if (!isProd && !process.env[name]) return 'dev-only-insecure-secret-not-for-production-use';
  const v = required(name);
  if (Buffer.byteLength(v, 'utf8') < 32) {
    throw new Error(`${name} must be at least 32 bytes; got ${Buffer.byteLength(v, 'utf8')}`);
  }
  return v;
}

const config = {
  isProd,
  port: Number(process.env.PORT || 8080),

  // The browser origin allowed to call this API. A wildcard with credentials is
  // rejected by browsers anyway, and a permissive default here is how a CSRF
  // hole gets shipped, so it is explicit or it is localhost.
  appOrigin: process.env.APP_ORIGIN || 'http://localhost:3000',

  db: {
    // In AWS this is the RDS endpoint and the password is rotated by Secrets
    // Manager. Locally it points at whatever cluster the tests started.
    connectionString: process.env.DATABASE_URL
      || 'postgres://app_user@localhost:5433/cre?host=/tmp',
    // The authentication role. A SEPARATE connection, because it holds
    // different privileges: it can read the sessions table and app_user cannot.
    // See migrations/002_auth_role.sql for why that split exists.
    authConnectionString: process.env.AUTH_DATABASE_URL
      || process.env.DATABASE_URL?.replace('app_user', 'auth_user')
      || 'postgres://auth_user@localhost:5433/cre?host=/tmp',
    // RDS requires TLS. Verification is on: without it, TLS proves only that
    // SOMETHING answered, which is not what it is for.
    ssl: isProd ? { rejectUnauthorized: true } : false,
    max: Number(process.env.DB_POOL_MAX || 10),
    statementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15000),
  },

  session: {
    signingSecret: secret('SESSION_SIGNING_SECRET'),
    // PREVIOUS signing key, accepted for verification but never used to issue.
    //
    // Without this, rotating the signing secret invalidates every CSRF token in
    // flight: every user's next save fails until they reload. The rotation you
    // perform under breach pressure would be the one that interrupts every firm
    // mid-underwriting, which is how rotations get postponed.
    //
    // Set it to the outgoing key, deploy, wait out one session lifetime, then
    // clear it. See docs/runbooks/secret-rotation.md.
    previousSigningSecret: process.env.SESSION_SIGNING_SECRET_PREVIOUS || null,
    cookieName: 'cre_session',
    // Eight hours: a working day, so an analyst is not re-authenticating
    // mid-model, and a shared machine does not stay logged in overnight.
    ttlMs: Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000),
    // Rotated well before expiry so a stolen cookie has a short useful life
    // without the user ever seeing a session end mid-task.
    rotateAfterMs: Number(process.env.SESSION_ROTATE_MS || 30 * 60 * 1000),
    // Idle expiry, distinct from the absolute lifetime above. A deal screen left
    // open on a shared workstation must not stay authenticated all afternoon.
    idleMs: Number(process.env.SESSION_IDLE_MS || 60 * 60 * 1000),
    // How often the idle clock is written back. Updating on every request makes
    // sessions the hottest table in the system for no security gain; a minute of
    // imprecision on an hour-long window costs nothing.
    touchIntervalMs: Number(process.env.SESSION_TOUCH_INTERVAL_MS || 60 * 1000),
  },

  /**
   * Rate limit ceilings.
   *
   * Tunable because they have to be. They were literals in app.js, which meant
   * the only way to measure this service's actual capacity was to edit the
   * source: a load test from one host is one client address, so it hits the
   * global ceiling within a second and every number after that describes the
   * limiter rather than the server. The first run of src/admin/loadtest.js did
   * exactly that — 62,000 requests, 62,124 of them 429 — and reported a pass.
   *
   * Defaults are the values that were hardcoded, so nothing changes by leaving
   * them alone. Raising them for a measurement run is a deliberate act with an
   * obvious name, and production still has the WAF in front doing the precise
   * counting per address.
   */
  rateLimits: {
    global: Number(process.env.RATE_LIMIT_GLOBAL || 600),
    auth: Number(process.env.RATE_LIMIT_AUTH || 30),
    export: Number(process.env.RATE_LIMIT_EXPORT || 5),
    csp: Number(process.env.RATE_LIMIT_CSP || 60),
  },

  /**
   * Duo, as a second factor we enforce ourselves.
   *
   * Per-tenant integrations live in the `tenant_duo` table; what lives here is
   * the platform's own two settings: the key their client secrets are sealed
   * with, and the callback Duo returns the browser to.
   */
  duo: {
    /**
     * The key that seals per-tenant Duo client secrets.
     *
     * 32 bytes, base64 or hex. Deliberately its OWN key rather than a reuse of
     * SESSION_SIGNING_SECRET: a key used to sign and a key used to encrypt must
     * be separable, or rotating either one silently rotates the other and the
     * rotation runbook becomes wrong in a way nobody discovers until a login
     * fails.
     *
     * Absent in development, which is not a hole: without it, `duoKey()` throws
     * and no tenant can have a Duo integration at all. The failure is a refusal
     * to configure, never a silently unencrypted secret.
     */
    configKey: process.env.DUO_CONFIG_KEY || null,
    // Must match the redirect registered on the Duo application exactly. Duo
    // compares it on both the authorize and the token call.
    redirectUri: process.env.DUO_REDIRECT_URI
      || 'http://localhost:8080/auth/duo/callback',
    // How long a person has to answer the prompt. Short on purpose: a pending
    // challenge is a resolved identity waiting for a factor, and a stolen
    // callback URL is worth nothing once it expires.
    pendingTtlMs: Number(process.env.DUO_PENDING_TTL_MS || 5 * 60 * 1000),
  },

  sso: {
    // 'workos' in every real environment. 'stub' exists so the entire login
    // flow is testable with no network and no vendor account — see auth/stub.js
    // for why that is a test fixture and not a back door.
    provider: process.env.SSO_PROVIDER || (isProd ? 'workos' : 'stub'),
    workos: {
      apiKey: process.env.WORKOS_API_KEY,
      clientId: process.env.WORKOS_CLIENT_ID,
      // Must match the redirect registered with the broker exactly.
      redirectUri: process.env.WORKOS_REDIRECT_URI
        || 'http://localhost:8080/auth/callback',
      apiBase: process.env.WORKOS_API_BASE || 'https://api.workos.com',
    },
    // Where the fake IdP page lives, for local demos only. Never read when the
    // provider is workos.
    stubBase: process.env.STUB_IDP_BASE || 'http://localhost:8080',
    // How long a login handshake may stay open. Long enough for a slow IdP
    // page, short enough that a leaked state parameter is stale.
    stateTtlMs: Number(process.env.SSO_STATE_TTL_MS || 10 * 60 * 1000),
  },
};

if (isProd) {
  if (config.duo.configKey && !config.duo.redirectUri.startsWith('https://')) {
    throw new Error('DUO_REDIRECT_URI must be https in production; Duo returns an '
      + 'authorization code to it');
  }
  if (config.sso.provider === 'stub') {
    throw new Error('SSO_PROVIDER=stub is a test fixture and must never run in production');
  }
  if (config.sso.provider === 'workos') {
    required('WORKOS_API_KEY');
    required('WORKOS_CLIENT_ID');
  }
  if (!config.appOrigin.startsWith('https://')) {
    throw new Error('APP_ORIGIN must be https in production; session cookies are Secure-only');
  }
}

module.exports = config;
