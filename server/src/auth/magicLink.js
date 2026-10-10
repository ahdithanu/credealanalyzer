'use strict';

const crypto = require('crypto');
const config = require('../config');
const { authPool } = require('../db/pool');
const mfa = require('./mfa');
const { mailer } = require('./mailer');
const { securityEvent, KIND, emailDomain } = require('../obs/securityLog');

/**
 * Single-use email sign-in links.
 *
 * This file does two things and deliberately not a third: it decides whether
 * an address MAY be mailed a link, and it claims a presented token exactly
 * once. It does not issue sessions and it does not provision users — that
 * stays in login.js, which is where a tenant is decided for every path, so
 * there is one place to read rather than two that must agree.
 *
 * WHAT THE MAGIC-LINK PATH HAS LESS OF. On the SSO path two independent facts
 * must agree: the broker's organization id resolves the tenant, and the
 * verified email domain confirms it. Here there is no assertion at all, so the
 * verified domain is the only binding between an address and a firm. Every
 * check below is a consequence of that single point of failure.
 */

const TOKEN_BYTES = 32;   // 43 base64url characters
const hash = (v) => crypto.createHash('sha256').update(v).digest();

/** Raised for every refusal. `code` is what the caller logs; see login.js. */
class MagicLinkError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = 'MagicLinkError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The address → tenant lookup, and the only one there is.
 *
 * Returns the tenant or throws. AMBIGUITY IS A REFUSAL, never a choice: a
 * domain verified for two firms means the link would admit its holder to
 * whichever row came back first, which is a cross-tenant admission with no
 * attacker involved. Migration 011 adds a unique index that makes this
 * unreachable; the check stays because a control that depends on an index
 * never being dropped is a control with a single point of failure.
 */
async function resolveTenantForEmail(email) {
  const domain = emailDomain(email);
  if (!domain) throw new MagicLinkError('bad_email', 'Unusable email address.', 400);

  const { rows } = await authPool.query(
    `SELECT t.id, t.slug, t.name, t.status, t.require_mfa, t.auth_methods
       FROM tenant_domains d
       JOIN tenants t ON t.id = d.tenant_id
      WHERE lower(d.domain) = $1 AND d.verified_at IS NOT NULL`,
    [domain],
  );

  if (rows.length === 0) {
    throw new MagicLinkError('unknown_domain', 'That domain is not verified for any organization.');
  }
  if (rows.length > 1) {
    throw new MagicLinkError('ambiguous_domain',
      'That domain is verified for more than one organization.');
  }
  return rows[0];
}

/**
 * May this tenant be entered by a mailed link at all?
 *
 * Called when the link is issued AND again when it is claimed. Not redundant:
 * a firm can revoke the method, be suspended, or turn on an MFA requirement in
 * the fifteen minutes a link is alive, and the check that matters is the one
 * at the moment of admission.
 */
async function assertMagicLinkAllowed(tenant) {
  if (tenant.status !== 'active') {
    throw new MagicLinkError('tenant_suspended', 'Access for your organization is suspended.');
  }

  // Defaulted to {sso} by migration 011, so a firm is never opted in by an
  // upgrade. Enabling this is a deliberate act per tenant.
  if (!(tenant.auth_methods || []).includes('magic_link')) {
    throw new MagicLinkError('method_not_allowed',
      'Your organization signs in through its identity provider.');
  }

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * `tenants.require_mfa = true` means "the identity provider must have
   * asserted a second factor". A mailed link asserts nothing — it proves
   * control of an inbox and that is all. So for a firm that requires MFA, a
   * magic link is only admissible if WE enforce the factor ourselves, which
   * means a configured Duo integration.
   *
   * Without this check, enabling magic links on an MFA-required tenant would
   * silently become the way to skip MFA: the policy is enforced in
   * login.complete() against the IdP's assertion, and that code never runs on
   * this path. The firm's security posture would be downgraded by a feature
   * flag, and nothing would report it.
   */
  if (tenant.require_mfa === true) {
    const duo = await mfa.configFor(tenant.id);
    if (!duo) {
      throw new MagicLinkError('mfa_required',
        'Your organization requires multi-factor authentication, which a sign-in '
        + 'link cannot provide.');
    }
  }
}

/** How many links this address has been sent in the last hour. */
async function recentLinkCount(email) {
  const { rows } = await authPool.query(
    `SELECT count(*)::int AS n FROM login_links
      WHERE lower(email) = lower($1) AND created_at > now() - interval '1 hour'`,
    [email],
  );
  return rows[0].n;
}

/**
 * Mint a link and mail it — or decide not to, and say nothing either way.
 *
 * ALWAYS RESOLVES, and always with the same value. Whether the address belongs
 * to a provisioned firm, whether that firm allows this method, whether it is
 * suspended: every one of those is invisible to the caller. Reporting any of
 * them turns this endpoint into a customer list and a user directory, readable
 * one address at a time by anyone on the internet.
 *
 * The refusals are not swallowed, they are MOVED: each one emits a security
 * event with its code, so an operator sees exactly what the caller does not.
 */
async function issue({ email, redirectTo, ip, userAgent }) {
  const refuse = (code) => {
    securityEvent(KIND.LOGIN_FAILED, {
      code: `magic_${code}`, domain: emailDomain(email), ip,
    });
    return { sent: true };
  };

  let tenant;
  try {
    tenant = await resolveTenantForEmail(email);
    await assertMagicLinkAllowed(tenant);
  } catch (err) {
    if (err instanceof MagicLinkError) return refuse(err.code);
    throw err;
  }

  // Per ADDRESS, on top of the per-IP limit the route applies. A caller
  // rotating source addresses past a per-IP limit is the actual abuse shape,
  // and the victim is the person whose inbox fills up.
  if (await recentLinkCount(email) >= config.magicLink.perEmailPerHour) {
    return refuse('rate_limited');
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  await authPool.query(
    `INSERT INTO login_links (token_hash, tenant_id, email, redirect_to, ip, user_agent, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::bigint * interval '1 millisecond'))`,
    [hash(token), tenant.id, email, relativeRedirect(redirectTo), ip || null,
      userAgent || null, config.magicLink.ttlMs],
  );

  const url = new URL(callbackUrl());
  url.searchParams.set('token', token);

  const minutes = Math.round(config.magicLink.ttlMs / 60000);
  await mailer().send({
    to: email,
    subject: `Sign in to ${tenant.name}`,
    text: [
      `Open this link to sign in. It works once and expires in ${minutes} minutes.`,
      '',
      url.toString(),
      '',
      'If you did not ask to sign in, you can ignore this — the link does nothing',
      'until it is opened, and nobody can open it without this message.',
    ].join('\n'),
  });

  // No success event here. KIND is a contract with the CloudWatch metric
  // filters in infra/lib/platform.js, asserted from both sides, and a new kind
  // with no alarm behind it is a field nothing reads. The signal that matters
  // on this path is refusals — above, and `magic_rate_limited` in particular.
  return { sent: true };
}

/**
 * Where the link points, checked the first time one is minted.
 *
 * Validated here rather than at startup for the reason given in mailer.js:
 * magic links are enabled per tenant, so a deployment whose firms all use SSO
 * never mints one and should not have to configure a callback it will never
 * use. Over http the token is readable in transit by anyone on the path, and
 * the token is a login.
 */
function callbackUrl() {
  const u = config.magicLink.callbackUrl;
  if (config.isProd && !u.startsWith('https://')) {
    throw new Error('MAGIC_LINK_CALLBACK_URL must be https in production; the link '
      + 'carries a single-use login token');
  }
  return u;
}

/**
 * Only a relative path survives. The same constraint login.begin() applies, for
 * the same reason: this value is echoed into a redirect after a session cookie
 * is set, so an absolute URL here is an open redirect that carries a freshly
 * authenticated user to someone else's site.
 */
function relativeRedirect(to) {
  if (typeof to !== 'string' || !to.startsWith('/') || to.startsWith('//')) return null;
  return to;
}

/**
 * Claim a presented token, exactly once.
 *
 * The single-use property is the UPDATE, not a read followed by a write. Two
 * clicks arriving together — a mail client prefetching the link while the
 * human also opens it is the common case, not a contrived one — would both
 * pass a `SELECT ... WHERE consumed_at IS NULL` and both proceed. Here the row
 * is claimed by the statement that finds it, so the second gets no row.
 *
 * Expiry is in the same predicate for the same reason: checked in JavaScript
 * after the read, it is a separate step that can be reordered or forgotten.
 */
async function claim(token) {
  if (!token || typeof token !== 'string') {
    throw new MagicLinkError('bad_token', 'This sign-in link is not valid.', 400);
  }
  const { rows } = await authPool.query(
    `UPDATE login_links
        SET consumed_at = now()
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
    RETURNING id, tenant_id, email, redirect_to`,
    [hash(token)],
  );
  if (!rows.length) {
    // One code for "never existed", "already used" and "expired". Three codes
    // would tell a holder of a guessed token which half of the guess was
    // wrong, and tell anyone whether an address has a link outstanding.
    throw new MagicLinkError('link_invalid',
      'This sign-in link is no longer valid. Please request a new one.');
  }
  return rows[0];
}

/** Expired and consumed links are not evidence; retention sweeps them. */
async function sweep() {
  const { rowCount } = await authPool.query(
    `DELETE FROM login_links WHERE expires_at < now() - interval '1 day'`,
  );
  return rowCount;
}

module.exports = {
  issue, claim, sweep, resolveTenantForEmail, assertMagicLinkAllowed, callbackUrl,
  MagicLinkError, relativeRedirect,
};
