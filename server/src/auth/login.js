'use strict';

const crypto = require('crypto');
const config = require('../config');
const { authPool, withTenant } = require('../db/pool');
const { broker } = require('./broker');
const session = require('./session');
const { emailDomain, securityEvent, KIND } = require('../obs/securityLog');
const mfa = require('./mfa');

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
 * Home realm discovery: which firm does this email address belong to?
 *
 * Returns a tenant slug suitable for `begin({ tenantHint })`, or null. Null is
 * not an error — it means the login proceeds unhinted and the broker asks which
 * organization, exactly as it does when nobody typed anything.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is tell the caller which happened. A
 * handler that answered "no firm is registered for that domain" would be a
 * customer list readable one domain at a time by anyone with a browser, and
 * client firms in this market do not want to be discoverable as customers. So
 * the caller gets a redirect either way and learns nothing from the difference.
 *
 * The oracle is not fully closed and saying so is more useful than pretending:
 * the two paths end at different identity providers, which an observer can
 * distinguish. That is inherent to home realm discovery — every enterprise SSO
 * product has the same property — and the mitigations are the ones applied
 * here: the endpoint is rate limited, and nothing about the firm beyond its
 * existing IdP relationship is revealed.
 *
 * Only VERIFIED domains resolve. An unverified row is a claim someone made
 * during onboarding, and routing on a claim would let a firm that typed a
 * competitor's domain into the form intercept where their users get sent.
 */
async function discoverTenant(email) {
  const domain = emailDomain(email);
  if (!domain) return null;
  const { rows } = await authPool.query(
    `SELECT t.slug
       FROM tenant_domains d
       JOIN tenants t ON t.id = d.tenant_id
      WHERE lower(d.domain) = $1
        AND d.verified_at IS NOT NULL
        AND t.status = 'active'
      LIMIT 1`,
    [domain],
  );
  return rows[0]?.slug || null;
}

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
  //
  // Note what is NOT written here any more: the `auth.login` audit entry. It
  // moved to issueSession(), because with a second factor in the flow this
  // point is no longer the end of a login — it is the middle of one. An entry
  // saying someone logged in, written before they had passed Duo, would be a
  // false statement in the one table whose value is that it is not.
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
    return { user: rows[0] };
  });

  const context = {
    tenant,
    user: result.user,
    redirectTo: stateRow.redirect_to || '/',
    ip,
    userAgent,
    domain,
    idp: profile.idpName || null,
    connectionId: profile.connectionId || null,
    authMethod: profile.authMethod || null,
    idpMfaAsserted: profile.mfaAsserted,
  };

  // ── The second factor, if this firm has one ───────────────────────────────
  const duoRow = await mfa.configFor(tenant.id);
  if (duoRow) return challengeDuo(duoRow, context);

  return issueSession(context, {
    // The provider asserted it; we did not verify it ourselves. Recorded as a
    // weaker claim than 'duo' precisely so the two are distinguishable later.
    mfaFactor: profile.mfaAsserted === true ? 'idp' : null,
  });
}

/**
 * Send the browser to Duo, or decide what to do because we cannot.
 *
 * The health check is a real round trip on every login for a Duo tenant, and it
 * earns its cost: it is the only thing that separates "Duo is down" from "Duo
 * was asked and said no". Without it the first contact with Duo would be the
 * token exchange, long after the browser has been redirected — so an outage
 * would present as a dead page at Duo's domain, and a fail-open tenant could
 * not be admitted without also admitting everyone Duo had actively refused.
 */
async function challengeDuo(duoRow, ctx) {
  const { tenant, user } = ctx;
  try {
    const client = mfa.clientFor(tenant.id, duoRow);
    await client.healthCheck();

    const { url, nonce } = await mfa.challenge({
      tenantId: tenant.id,
      user,
      duoRow,
      redirectTo: ctx.redirectTo,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: ctx.authMethod,
      idpMfaAsserted: ctx.idpMfaAsserted,
    });

    await auditAuth(tenant.id, user.id, 'auth.mfa_challenged', {
      factor: 'duo', domain: ctx.domain,
    }, ctx.ip);

    return { kind: 'mfa', url, nonce };
  } catch (err) {
    return duoFailure(err, duoRow, ctx);
  }
}

/**
 * What happens when Duo cannot answer.
 *
 * TWO CASES, and conflating them is how a second factor gets quietly disabled:
 *
 *   reachable === false  Duo was not contactable. A tenant configured to fail
 *                        open may be admitted, loudly.
 *   reachable === true   Duo was contacted and something was wrong — a refused
 *                        credential, an expired token, a username that did not
 *                        match. NOBODY is admitted on this, whatever the fail
 *                        mode says, because the failure is an answer.
 */
async function duoFailure(err, duoRow, ctx) {
  const { tenant, user } = ctx;
  const code = err?.code || 'error';
  const unreachable = err?.reachable === false;

  securityEvent(KIND.MFA_FAILED, {
    tenant: tenant.id, user: user.id, code, unreachable,
  });

  if (unreachable && duoRow.fail_mode === 'open') {
    // Admitted without a second factor. Every trace this leaves is deliberate:
    // a security event the alarm in infra/lib/platform.js watches, an audit
    // entry the customer can read in their own log, and a distinct value in
    // sessions.mfa_factor so "which sessions skipped Duo" is answerable months
    // later rather than inferred.
    securityEvent(KIND.MFA_FAILOPEN, { tenant: tenant.id, user: user.id, code });
    await auditAuth(tenant.id, user.id, 'auth.mfa_failopen', {
      factor: 'duo', reason: code, domain: ctx.domain,
    }, ctx.ip);
    return issueSession(ctx, { mfaFactor: 'duo_failopen' });
  }

  await auditAuth(tenant.id, user.id, 'auth.mfa_failed', {
    factor: 'duo', reason: code, unreachable, domain: ctx.domain,
  }, ctx.ip);

  // One code to the browser for every cause. The operator log carries the
  // detail; the sign-in page must not become a way to probe a firm's Duo
  // configuration from outside it.
  throw new LoginError('mfa_failed',
    `The second factor could not be completed: ${code}`, 403,
    { orgId: null, domain: ctx.domain });
}

/**
 * Finish a Duo round trip and issue the session.
 *
 * Reached from GET /auth/duo/callback. Everything it trusts comes from the
 * `mfa_pending` row it claims, never from the request: the request supplies two
 * opaque handles and an authorization code, and nothing else it says is read.
 */
async function completeDuo({ state, nonce, code, error, ip, userAgent }) {
  const pending = await mfa.consumePending(state, nonce);
  if (!pending) {
    // Unknown, already used, expired, or a different browser — one answer for
    // all four, same as consumeState().
    securityEvent(KIND.MFA_FAILED, { code: 'bad_pending', unreachable: false });
    throw new LoginError('mfa_failed', 'This second-factor link is no longer valid.', 403);
  }

  const { rows: tenantRows } = await authPool.query(
    'SELECT id, slug, name, status FROM tenants WHERE id = $1', [pending.tenant_id]);
  const tenant = tenantRows[0];
  // Re-checked, not assumed. The tenant was active when the challenge was
  // issued; five minutes is short but it is not zero, and a firm suspended
  // during that window must not have a session minted for it afterwards.
  if (!tenant || tenant.status !== 'active') {
    throw new LoginError('tenant_suspended', 'Access for your organization is suspended.', 403);
  }

  const ctx = {
    tenant,
    user: { id: pending.user_id, email: pending.duo_username },
    redirectTo: pending.redirect_to || '/',
    ip,
    userAgent,
    domain: emailDomain(pending.duo_username),
    authMethod: pending.auth_method,
    idpMfaAsserted: pending.idp_mfa_asserted,
  };

  const duoRow = await mfa.configFor(tenant.id);
  if (!duoRow) {
    // Duo was turned off between the challenge and the callback. Refused rather
    // than waved through: the login was started under a policy that required a
    // factor, and this one has not produced it.
    await auditAuth(tenant.id, pending.user_id, 'auth.mfa_failed', {
      factor: 'duo', reason: 'disabled_mid_flight',
    }, ip);
    throw new LoginError('mfa_failed', 'The second factor is no longer configured.', 403);
  }

  // Duo reports a user-side failure by redirecting back with an error rather
  // than a code — a denied push, a timeout, a locked-out account.
  if (error) {
    securityEvent(KIND.MFA_FAILED, { tenant: tenant.id, user: pending.user_id,
      code: 'duo_denied', unreachable: false });
    await auditAuth(tenant.id, pending.user_id, 'auth.mfa_failed', {
      factor: 'duo', reason: 'denied',
    }, ip);
    throw new LoginError('mfa_denied', 'The second factor was denied or timed out.', 403);
  }

  let verified;
  try {
    const client = mfa.clientFor(tenant.id, duoRow);
    // The username comes from the pending ROW, not the request. This is the
    // argument that makes the whole factor mean something — see the note at the
    // top of auth/duo.js.
    verified = await client.exchange(code, pending.duo_username);
  } catch (err) {
    return duoFailure(err, duoRow, ctx);
  }

  return issueSession(ctx, {
    mfaFactor: 'duo',
    duoDetail: {
      result: verified.result, status: verified.status, device: verified.device,
    },
  });
}

/**
 * Mint the session and write the one audit entry that says a login happened.
 *
 * Shared by every path that ends in a session — no Duo, Duo passed, Duo failed
 * open — so there is exactly one place where a session comes into existence and
 * exactly one place that records it.
 */
async function issueSession(ctx, { mfaFactor = null, duoDetail = null } = {}) {
  const { tenant, user } = ctx;

  await auditAuth(tenant.id, user.id, 'auth.login', {
    idp: ctx.idp || null,
    connectionId: ctx.connectionId || null,
    // The domain, not the address: the audit trail records how the decision was
    // reached without duplicating personal data into a table with a long
    // retention.
    domain: ctx.domain,
    // How they authenticated, as the provider stated it. An empty value means
    // the provider said nothing, which is itself worth recording.
    authMethod: ctx.authMethod || null,
    mfaAsserted: ctx.idpMfaAsserted ?? null,
    // What we actually verified, as opposed to what we were told.
    mfaFactor,
    duo: duoDetail,
  }, ctx.ip);

  // Outside the tenant transaction by necessity: minting a session is the auth
  // role's job, and the tenant-data role has no grant on `sessions`. See
  // session.issue() for why that ordering is the right trade.
  const issued = await session.issue(null, {
    userId: user.id, tenantId: tenant.id, ip: ctx.ip, userAgent: ctx.userAgent,
    authMethod: ctx.authMethod || null,
    mfaAsserted: ctx.idpMfaAsserted,
    mfaFactor,
  });

  return {
    kind: 'session',
    token: issued.token,
    expiresAt: issued.expiresAt,
    redirectTo: ctx.redirectTo,
    user,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
  };
}

/** One audit entry, written inside the tenant's own row level security. */
async function auditAuth(tenantId, userId, action, detail, ip) {
  await withTenant(tenantId, null, async (db) => {
    await db.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, subject_type, subject_id, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, userId, action, 'user', userId, JSON.stringify(detail), ip || null],
    );
  });
}

module.exports = { begin, complete, completeDuo, consumeState, discoverTenant, LoginError };
