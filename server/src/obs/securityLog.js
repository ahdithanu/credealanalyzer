'use strict';

/**
 * Security events, as structured lines on stdout.
 *
 * This module exists because of a gap found while writing the CloudWatch
 * alarms: the alarms were going to be metric filters over the API's log group,
 * and the API logged almost nothing a filter could match. Requests were
 * refused — a bad CSRF token, an unverified email domain, a replayed SSO state
 * — and refused correctly, and left no trace anywhere an operator would look.
 * An alarm written against a pattern the application never emits is worse than
 * no alarm: it is a dashboard that is green because it is blind.
 *
 * So: every refusal that could be the first minute of an incident emits one
 * line here, and the metric filters in infra/lib/platform.js match on these
 * exact field names. The two are a contract; `server/test/securityLog.test.js`
 * asserts the shape, and infra/test/synth.test.js asserts the filters match it.
 *
 * WHAT IS NOT LOGGED, and why:
 *
 *   - No session token, no CSRF token, no bearer token, no authorization code.
 *     These lines land in CloudWatch, which a wider set of people can read than
 *     can read the database. A log that carries a live credential has moved the
 *     credential rather than recorded the event.
 *   - No full email address. The DOMAIN is kept, because "forty failures from
 *     one domain" is the signal an operator acts on, and the local part is a
 *     named individual at a client firm. Tenant and user ids are kept: they are
 *     opaque outside the database, and they are what an investigation needs.
 *   - No request body, ever.
 *
 * Every value is length-capped before it is written. `JSON.stringify` already
 * escapes newlines so a caller cannot forge a log line, but an attacker-chosen
 * megabyte in a `script-sample` is its own kind of denial of service against
 * the log group's ingestion bill.
 */

const MAX_FIELD = 200;

/** Cap a value, whatever shape it arrives in, so no caller can bloat a line. */
function cap(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  const s = String(v);
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
}

/**
 * The domain half of an email, lowercased. Returns null rather than guessing
 * when the input is not an address — a login failure caused by a malformed
 * email should not put the malformed string in the log under a field name that
 * says "domain".
 */
function emailDomain(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? cap(domain) : null;
}

/**
 * Emit one security event.
 *
 * `evt: 'security'` is the discriminator every metric filter starts with, so a
 * filter can never accidentally match an ordinary application log line that
 * happens to carry a `kind` field.
 *
 * Written to stderr rather than stdout: on a container whose stdout is being
 * sampled or truncated by a log driver, the security trail should be the half
 * that survives. Both go to the same CloudWatch stream under awslogs.
 */
function securityEvent(kind, fields = {}) {
  const line = { evt: 'security', kind, at: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    line[k] = cap(v);
  }
  console.error(JSON.stringify(line));
}

/**
 * The event kinds. Named here rather than spelled at each call site so that a
 * typo is a crash instead of an event that silently never matches its alarm —
 * the exact failure this module was written to prevent.
 */
const KIND = {
  // A request arrived with no usable session. Ordinary and frequent: every
  // anonymous page load produces one. Alarmed on RATE, never on presence.
  SESSION_REJECTED: 'session_rejected',
  // A session was present and the CSRF token was not valid for it. This is not
  // ordinary. A browser that has a session has a token.
  CSRF_REJECTED: 'csrf_rejected',
  // A state-changing request from an origin that is not the app's.
  ORIGIN_REJECTED: 'origin_rejected',
  // Authenticated, and not permitted to do this. Sustained volume from one user
  // is someone exploring the edges of their role.
  ROLE_DENIED: 'role_denied',
  // An SSO handshake was refused. `code` carries WHY (unverified domain,
  // unknown organization, suspended tenant, replayed state, MFA required) and
  // is the single most useful security signal in the system.
  LOGIN_FAILED: 'login_failed',
  // A SCIM bearer token failed to authenticate.
  SCIM_AUTH_FAILED: 'scim_auth_failed',
  // A caller hit a rate limit. Which limiter is in `limiter`.
  RATE_LIMITED: 'rate_limited',
  // A second factor we enforce ourselves did not pass. Covers a refused Duo
  // credential, a failed signature, an expired token and — most importantly —
  // a username mismatch, which is what an attempt to bind someone else's
  // successful second factor to this login looks like.
  MFA_FAILED: 'mfa_failed',
  // A session was issued WITHOUT the second factor its tenant requires, because
  // Duo could not be reached and that tenant is configured to admit on failure.
  // Rare, deliberate, and alarmed on every occurrence: this is the event that
  // says the control was not applied.
  MFA_FAILOPEN: 'mfa_failopen',
  // The browser reported a Content-Security-Policy violation.
  CSP_VIOLATION: 'csp_violation',
  // An unhandled error reached the error handler with a 5xx.
  SERVER_ERROR: 'server_error',
};

module.exports = { securityEvent, emailDomain, KIND, MAX_FIELD };
