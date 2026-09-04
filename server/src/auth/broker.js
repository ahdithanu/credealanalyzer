'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * The SSO broker, behind an interface.
 *
 * Two implementations: WorkOS for every real environment, and a stub for tests.
 * The interface exists because the security-critical logic is what happens to a
 * profile AFTER it comes back — which tenant it maps to, whether the email
 * domain is verified, whether the state was replayed — and that logic has to be
 * testable without a vendor account, a browser, or outbound network. A test that
 * cannot run is a test that does not protect anything.
 *
 * A broker is used rather than per-tenant SAML code because each client firm
 * arrives with a different identity provider. Onboarding a firm should be
 * configuration, not a bespoke integration and a release.
 *
 * The contract:
 *   authorizationUrl({ state, organizationId? }) -> string
 *   exchange(code) -> { organizationId, email, emailVerified, externalId, name,
 *                       connectionId, idpName }
 */

// ─── WorkOS ──────────────────────────────────────────────────────────────────

/**
 * Turn a WorkOS token response into the profile the rest of the system uses.
 *
 * Separated from the request so it can be tested without a network, and
 * VALIDATED rather than destructured optimistically.
 *
 * The failure this prevents is a bad one. `body.profile || {}` leaves every
 * field undefined when the envelope is not what we expect — a changed response
 * shape, an error returned with a 200, a different API version — and the caller
 * then throws `no_org`, which reaches the user as "your identity provider did
 * not identify your organization". Someone spends a day in their Okta
 * configuration for a fault that is entirely ours. A parser that cannot read
 * its input must say so in those words.
 *
 * TARGETS the WorkOS SSO API (`POST /sso/token`), whose success body is
 * `{ access_token, profile: { id, connection_id, organization_id, email, ... } }`.
 * The newer User Management API returns a different envelope; this does not
 * attempt to read both, because guessing at a shape nobody here has observed is
 * how you get a parser that is confidently wrong about two APIs instead of one.
 */
function parseProfile(body) {
  const p = body && typeof body === 'object' ? body.profile : null;
  if (!p || typeof p !== 'object') {
    // Key names only, never values: this body carries an access token and the
    // user's personal details, and this message reaches the logs.
    const keys = body && typeof body === 'object' ? Object.keys(body).join(', ') : typeof body;
    throw Object.assign(
      new Error(`sso token response has no \`profile\` object (top-level keys: ${keys})`),
      { status: 502, code: 'sso_shape' },
    );
  }

  // The three the system cannot proceed without: the organization decides the
  // TENANT, and the email decides admission via the verified-domain check.
  const missing = ['organization_id', 'email'].filter((k) => !p[k]);
  if (missing.length) {
    throw Object.assign(
      new Error(
        `sso profile is missing ${missing.join(' and ')} `
        + `(profile keys: ${Object.keys(p).join(', ')})`,
      ),
      { status: 502, code: 'sso_shape' },
    );
  }

  return {
    organizationId: p.organization_id,
    email: p.email,
    // WorkOS asserts an email only after the identity provider has, so its
    // presence in a COMPLETED SSO profile is the verification. Stated as an
    // explicit field so the caller's domain check reads identically against any
    // broker, including one where verification is a separate claim.
    emailVerified: Boolean(p.email),
    externalId: p.idp_id || p.id || null,
    name: [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
    connectionId: p.connection_id || null,
    idpName: p.connection_type || null,
  };
}

function workosBroker() {
  const { apiKey, clientId, redirectUri, apiBase } = config.sso.workos;

  return {
    name: 'workos',

    authorizationUrl({ state, organizationId }) {
      const u = new URL('/sso/authorize', apiBase);
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('state', state);
      // Naming the organization sends the user straight to their own IdP.
      // Omitted, the broker asks which firm they belong to. Either way the
      // organization on the RETURNED profile is what decides the tenant — this
      // is a routing hint, and a client that tampers with it gets sent to an
      // IdP that will not authenticate them.
      if (organizationId) u.searchParams.set('organization', organizationId);
      return u.toString();
    },

    async exchange(code) {
      const res = await fetch(new URL('/sso/token', apiBase), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: apiKey,
          grant_type: 'authorization_code',
          code,
        }),
      });
      if (!res.ok) {
        // The broker's body can echo the authorization code. Never logged or
        // surfaced — the status is enough to act on.
        throw Object.assign(new Error(`sso token exchange failed (${res.status})`), { status: 502 });
      }
      const body = await res.json();
      return parseProfile(body);
    },
  };
}

// ─── Stub, for tests and offline development ─────────────────────────────────

/**
 * A fake identity provider.
 *
 * This is a TEST FIXTURE, not a fallback. config.js refuses to boot in
 * production with SSO_PROVIDER=stub, because a broker that mints an identity
 * from a query parameter is a total authentication bypass — anyone could name
 * any organization and any email and be admitted. That guard is the only reason
 * this file is safe to ship, so do not remove it.
 *
 * It exists because the interesting security decisions are all downstream of
 * the handshake, and they deserve real tests.
 */
function stubBroker() {
  const codes = new Map();

  return {
    name: 'stub',

    authorizationUrl({ state, organizationId }) {
      // Mints a code that the fake IdP would hand back, and parks the identity
      // against it. A real IdP holds this server-side; so does this.
      const code = `stub_${crypto.randomBytes(8).toString('hex')}`;
      codes.set(code, { organizationId, state });
      // Points at this server's own fake IdP page, so the whole flow is
      // CLICKABLE in a browser for a local demo. It used to point at
      // stub-idp.invalid, which is unresolvable by design — correct for unit
      // tests, and it meant nobody could actually sign in to look at the thing.
      const u = new URL('/auth/stub', config.sso.stubBase || 'http://localhost:8080');
      u.searchParams.set('state', state);
      u.searchParams.set('code', code);
      if (organizationId) u.searchParams.set('organization', organizationId);
      return u.toString();
    },

    /** Test-only: declare who the fake IdP will assert for a code. */
    __setProfile(code, profile) {
      codes.set(code, { ...(codes.get(code) || {}), profile });
    },

    async exchange(code) {
      const entry = codes.get(code);
      if (!entry) throw Object.assign(new Error('unknown code'), { status: 400 });
      // Single-use, as a real authorization code is.
      codes.delete(code);
      if (!entry.profile) throw Object.assign(new Error('no profile staged'), { status: 400 });
      return entry.profile;
    },
  };
}

let instance = null;

function broker() {
  if (!instance) {
    instance = config.sso.provider === 'workos' ? workosBroker() : stubBroker();
  }
  return instance;
}

/** Tests only, so each file starts from a clean broker. */
function __reset() { instance = null; }

module.exports = { broker, __reset, workosBroker, stubBroker, parseProfile };
