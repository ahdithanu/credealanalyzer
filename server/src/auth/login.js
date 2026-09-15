'use strict';

const crypto = require('crypto');
const config = require('../config');
const { authPool, withTenant } = require('../db/pool');
const { broker } = require('./broker');
const session = require('./session');
const { emailDomain } = require('../obs/securityLog');

/**
 * The login handshake: where a tenant is DECIDED.
 *
 * Everything downstream — row level security, the audit trail, every query in
 * every route — inherits whatever this file concludes. If it can be talked into
 * the wrong tenant, none of the rest matters. So the rules here are narrow on
 * purpose, and each one is a defence against a specific attack rather than a
 * general good practice.
 */

/**
 * Begin a login. Returns the URL to redirect the browser to.
 *
 * `tenantHint` (a firm slug from the login form) is only ever a ROUTING hint:
 * it selects which IdP to send the user to. It is never used to decide what
 * they can see. A user who tampers with it is sent to a directory that will
 * refuse to authenticate them.
 */
async function begin({ tenantHint, redirectTo, ip }) {
  // 32 bytes of CSPRNG. The state parameter is what ties the callback to a
  // login THIS browser started: without it an attacker can run a handshake with
  // their own credentials and hand the victim the resulting callback URL,
  // silently logging the victim into the attacker's account and any deal they
  // then enter goes into the attacker's tenant. Recorded server-side and
  // single-use, so it also cannot be replayed.
  const state = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sso.stateTtlMs);

  // Only relative paths. An open redirect here would let a phishing page
  // borrow our domain to bounce a freshly authenticated user somewhere else.
  const safeRedirect = typeof redirectTo === 'string'
    && redirectTo.startsWith('/')
    && !redirectTo.startsWith('//')
    ? redirectTo
    : '/';

  let organizationId = null;
  if (tenantHint) {
    const { rows } = await authPool.query(
      `SELECT broker_org_id FROM tenants
        WHERE slug = $1 AND status = 'active' AND broker_org_id IS NOT NULL`,
      [String(tenantHint).slice(0, 200)],
    );
    organizationId = rows[0]?.broker_org_id || null;
  }

  await authPool.query(
    'INSERT INTO sso_states (state, tenant_hint, redirect_to, expires_at) VALUES ($1,$2,$3,$4)',
    [state, tenantHint || null, safeRedirect, expiresAt],
  );

  return {
    url: broker().authorizationUrl({ state, organizationId }),
    state,
  };
}

class LoginError extends Error {
  /**
   * @param {string} code    what the SPA renders, and what the security log and
   *                         its CloudWatch alarm key on
   * @param {string} message human-readable, never returned to the browser
   * @param {number} status
   * @param {object} context non-identifying detail for the security log ONLY —
   *                         the organization id the provider asserted and the
   *                         email DOMAIN. Attached to the error rather than
   *                         logged here so there is exactly one emission point
   *                         (routes/auth.js), which is what keeps a single
   *                         refused login from producing two alarm-bearing
   *                         lines and doubling every rate an operator reads.
   */
  constructor(code, message, status = 401, context = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.orgId = context.orgId ?? null;
    this.domain = context.domain ?? null;
  }
}

/**
 * Consume the state parameter. Single-use, atomically.
 *
 * The UPDATE ... WHERE consumed_at IS NULL RETURNING is one statement so two
 * concurrent callbacks with the same state cannot both win — a check-then-act
 * pair here would be a replay window.
 */
async function consumeState(state) {
  if (!state || typeof state !== 'string') throw new LoginError('bad_state', 'Missing state');
  const { rows } = await authPool.query(
    `UPDATE sso_states SET consumed_at = now()
      WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING state, tenant_hint, redirect_to`,
    [state],
  );
  if (!rows[0]) {
    // Deliberately one error for all three causes — unknown, already used,
    // expired. Distinguishing them tells an attacker probing states which of
    // their guesses existed.
    throw new LoginError('bad_state', 'This sign-in link is no longer valid. Please start again.');
  }
  return rows[0];
}

/**
 * Complete a login. Returns the session token and where to send the browser.
 *
 * THE TENANT COMES FROM THE ASSERTION. `profile.organizationId` was set by the
 * broker after the identity provider authenticated the user; it is not
 * reachable from the request. That is the single most important line in this
 * codebase from a security standpoint.
 */
async function complete({ state, code, ip, userAgent }) {
  const stateRow = await consumeState(state);

  const profile = await broker().exchange(code);

  if (!profile?.organizationId) {
    throw new LoginError('no_org', 'Your identity provider did not identify your organization.',
      401, { orgId: null, domain: emailDomain(profile?.email) });
  }
  if (!profile.email || !profile.emailVerified) {
    // An unverified address is a claim, not an identity. Admitting one lets
    // anyone who can set a display name in a loose directory claim a colleague.
    throw new LoginError('unverified_email', 'Your identity provider did not supply a verified email address.',
      401, { orgId: profile.organizationId, domain: emailDomain(profile.email) });
  }

  const email = String(profile.email).trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) {
    throw new LoginError('bad_email', 'Your identity provider supplied an unusable email address.',
      401, { orgId: profile.organizationId });
  }
  const domain = email.slice(at + 1);

  // Resolve the tenant by the BROKER's organization id.
  const { rows: tenantRows } = await authPool.query(
    `SELECT id, slug, name, status, require_mfa FROM tenants WHERE broker_org_id = $1`,
    [profile.organizationId],
  );
  const tenant = tenantRows[0];
  if (!tenant) {
    // No auto-created tenants. A firm exists because someone onboarded it; a
    // login that conjures one would let an unknown organization become a tenant
    // of a product sold on the promise that firms are separated.
    throw new LoginError('unknown_org', 'Your organization is not provisioned. Contact your administrator.',
      403, { orgId: profile.organizationId, domain });
  }
  if (tenant.status !== 'active') {
    throw new LoginError('tenant_suspended', 'Access for your organization is suspended.',
      403, { orgId: profile.organizationId, domain });
  }

  // The email domain must be VERIFIED for this tenant. This is the backstop
  // against a misconfigured SSO connection: if a connection were pointed at the
  // wrong organization, or an IdP asserted an outside address, the domain check
  // is what stops that address landing inside a client firm's tenant.
  const { rows: domainRows } = await authPool.query(
    `SELECT 1 FROM tenant_domains
      WHERE tenant_id = $1 AND lower(domain) = $2 AND verified_at IS NOT NULL`,
    [tenant.id, domain],
  );
  if (!domainRows.length) {
    throw new LoginError('domain_not_verified',
      'Your email domain is not verified for this organization.', 403,
      { orgId: profile.organizationId, domain });
  }

  // A tenant may require that the identity provider asserted a second factor.
  // NULL means no policy — not "off" — so a tenant is never silently opted in.
  // Enforced HERE rather than at the screen, because a policy checked after a
  // session exists is a policy an attacker can skip by not loading the screen.
  if (tenant.require_mfa === true && profile.mfaAsserted !== true) {
    throw new LoginError('mfa_required',
      'Your organization requires multi-factor authentication, and your identity '
      + 'provider did not confirm it was used.', 403,
      { orgId: profile.organizationId, domain });
  }

  // Just-in-time provisioning, inside the tenant context so the INSERT is
  // subject to the same row level security as everything else. A new analyst
  // signs in and exists; nobody maintains a parallel user list by hand.
  const result = await withTenant(tenant.id, null, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO users (tenant_id, email, name, external_id, last_login_at)
            VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, email) DO UPDATE
            SET last_login_at = now(),
                name        = COALESCE(EXCLUDED.name, users.name),
                -- Bound to the IdP subject on first sight and not overwritten
                -- afterwards: a changed subject for a known address means the
                -- directory was reconfigured, and silently re-binding would
                -- hand the account to whoever holds the address now.
                external_id = COALESCE(users.external_id, EXCLUDED.external_id)
       RETURNING id, email, name, role`,
      [tenant.id, email, profile.name || null, profile.externalId || null],
    );
    const user = rows[0];

    await db.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, subject_type, subject_id, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenant.id, user.id, 'auth.login', 'user', user.id,
        JSON.stringify({
          idp: profile.idpName || null,
          connectionId: profile.connectionId || null,
          // The domain, not the address: the audit trail records how the
          // decision was reached without duplicating personal data into a table
          // with a long retention.
          domain,
          // How they authenticated, as the provider stated it. An empty value
          // means the provider said nothing, which is itself worth recording.
          authMethod: profile.authMethod || null,
          mfaAsserted: profile.mfaAsserted ?? null,
        }), ip || null],
    );

    return { user };
  });

  // Outside the tenant transaction by necessity: minting a session is the auth
  // role's job, and the tenant-data role has no grant on `sessions`. See
  // session.issue() for why that ordering is the right trade.
  const issued = await session.issue(null, {
    userId: result.user.id, tenantId: tenant.id, ip, userAgent,
    authMethod: profile.authMethod || null,
    mfaAsserted: profile.mfaAsserted,
  });

  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    redirectTo: stateRow.redirect_to || '/',
    user: result.user,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
  };
}

module.exports = { begin, complete, consumeState, LoginError };
