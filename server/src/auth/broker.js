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
        // The broker's body can echo the code. Never logged or surfaced.
        throw Object.assign(new Error('sso token exchange failed'), { status: 502 });
      }
      const body = await res.json();
      const p = body.profile || {};
      return {
        organizationId: p.organization_id,
        email: p.email,
        // WorkOS asserts an email only after the IdP has, so its presence in a
        // completed SSO profile IS the verification. Kept as an explicit field
        // so the caller's domain check reads the same against any broker.
        emailVerified: Boolean(p.email),
        externalId: p.idp_id || p.id,
        name: [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
        connectionId: p.connection_id,
        idpName: p.connection_type || null,
      };
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
      const u = new URL('http://stub-idp.invalid/authorize');
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

module.exports = { broker, __reset, workosBroker, stubBroker };
