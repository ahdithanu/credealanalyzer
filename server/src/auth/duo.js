'use strict';

const crypto = require('crypto');

/**
 * Duo Universal Prompt, implemented directly against the protocol.
 *
 * NO SDK, and that is a considered choice rather than a preference. This server
 * has two runtime dependencies, express and pg, which is most of why its
 * advisory surface is what it is. `duo_universal` would add a transitive tree
 * to the one code path where a supply-chain compromise is worth the most to an
 * attacker: the one that decides whether a second factor passed. The protocol
 * below is four HTTPS calls and two JWTs. Writing it means the verification is
 * visible in this file and reviewable in one sitting.
 *
 * What it does NOT mean is inventing crypto: every signature is HMAC-SHA512
 * through node's `crypto`, compared in constant time, with the algorithm pinned
 * rather than read from the token.
 *
 * ── The protocol ────────────────────────────────────────────────────────────
 *
 *   health check  POST {api_host}/oauth/v1/health_check   client assertion JWT
 *   authorize     GET  {api_host}/oauth/v1/authorize      signed request JWT
 *   token         POST {api_host}/oauth/v1/token          client assertion JWT
 *                                                         → id_token (JWT)
 *
 * Both JWTs are signed HS512 with the integration's client secret, which is why
 * the secret never leaves the server and why the browser is only ever handed an
 * opaque state value.
 *
 * ── The bug this file is written around ─────────────────────────────────────
 *
 * The classic way to get a second factor integration wrong is to treat "Duo
 * returned a success" as "this login is authorised". It is not. Duo answers the
 * question it was asked, and the answer names WHO it is about, in
 * `preferred_username`. An integration that skips that comparison can be
 * defeated by an attacker who completes Duo perfectly legitimately as
 * themselves and then feeds the resulting callback to a login pending for
 * somebody else — the second factor passes, for the wrong person.
 *
 * `verifyIdToken` therefore takes the expected username as a required argument
 * and refuses to be called without one. See `exchange`.
 */

const AUTH_PATH = '/oauth/v1/authorize';
const TOKEN_PATH = '/oauth/v1/token';
const HEALTH_PATH = '/oauth/v1/health_check';

/** Duo fixes these lengths; a value of the wrong size is a configuration error. */
const CLIENT_ID_LEN = 20;
const CLIENT_SECRET_LEN = 40;

/**
 * The api_host becomes the host of an outbound HTTPS request made from inside
 * our VPC, carrying a signed client assertion. It is therefore validated
 * strictly rather than trusted: an operator typo, or a compromised admin path,
 * must not be able to aim the token exchange at an arbitrary host. Duo's hosts
 * are always api-<8 hex>.duosecurity.com, or the .duofederal.com equivalent for
 * the FedRAMP environment.
 */
const API_HOST = /^api-[0-9a-f]{8}\.duosecurity\.com$|^api-[0-9a-f]{8}\.duofederal\.com$/;

/** Duo requires state between these lengths. */
const STATE_MIN = 22;
const STATE_MAX = 1024;

/** How long a signed assertion is good for. Short: these are used immediately. */
const ASSERTION_TTL_S = 300;
/** Clock skew allowed when checking `iat` on Duo's answer. */
const LEEWAY_S = 60;
/**
 * Every call to Duo is bounded. Without this a Duo outage that accepts
 * connections and never answers would hold a request — and the pooled
 * connection behind it — until something else gave up first, turning their
 * outage into ours.
 */
const TIMEOUT_MS = 10_000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uJson = (obj) => b64u(JSON.stringify(obj));

/** HMAC-SHA512 over the signing input, as base64url. */
function sign(input, secret) {
  return crypto.createHmac('sha512', secret).update(input).digest('base64url');
}

/** Mint a JWT. HS512 always — the algorithm is never a parameter. */
function jwt(claims, secret) {
  const head = b64uJson({ alg: 'HS512', typ: 'JWT' });
  const body = b64uJson(claims);
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

class DuoError extends Error {
  /**
   * @param {string} code      stable, safe to log and to alarm on
   * @param {string} message   for the operator, never for the browser
   * @param {boolean} reachable whether Duo answered at all. This is the flag the
   *   fail-open decision turns on: a tenant that admits users when Duo is
   *   unreachable must NOT admit them when Duo was reached and said no.
   */
  constructor(code, message, { reachable = true } = {}) {
    super(message);
    this.code = code;
    this.reachable = reachable;
  }
}

/**
 * Verify and decode a JWT that Duo signed.
 *
 * The order matters and is the usual place these go wrong:
 *
 *  1. Structure, before anything is parsed as JSON.
 *  2. The algorithm, compared against ONE permitted value. A verifier that
 *     reads `alg` out of the header and dispatches on it accepts `none`, and a
 *     verifier that accepts the header's word for a symmetric algorithm when it
 *     expected an asymmetric one accepts the public key as an HMAC secret.
 *  3. The signature, in constant time.
 *  4. Only then, the claims.
 */
function verifyJwt(token, secret) {
  if (typeof token !== 'string') throw new DuoError('token_malformed', 'id_token is not a string');
  const parts = token.split('.');
  if (parts.length !== 3) throw new DuoError('token_malformed', 'id_token is not three segments');
  const [head, body, sig] = parts;

  let header;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    throw new DuoError('token_malformed', 'id_token header is not JSON');
  }
  // Pinned, not negotiated.
  if (header.alg !== 'HS512') {
    throw new DuoError('token_alg', `id_token algorithm is ${header.alg}, expected HS512`);
  }

  const expected = Buffer.from(sign(`${head}.${body}`, secret), 'utf8');
  const given = Buffer.from(sig, 'utf8');
  // Length first: timingSafeEqual throws on a mismatch, and that throw is
  // itself an oracle if it is the only thing distinguishing the two cases.
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    throw new DuoError('token_signature', 'id_token signature does not verify');
  }

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new DuoError('token_malformed', 'id_token payload is not JSON');
  }
}

/**
 * A Duo integration for one tenant.
 *
 * Constructed per login rather than cached: the configuration is read from the
 * database on the auth path anyway, and a cached client holding a decrypted
 * client secret is a decrypted client secret living longer than it needs to.
 */
class DuoClient {
  constructor({ apiHost, clientId, clientSecret, redirectUri }) {
    if (!API_HOST.test(String(apiHost || ''))) {
      throw new DuoError('config_api_host',
        `api_host ${JSON.stringify(apiHost)} is not a Duo API hostname`);
    }
    if (String(clientId || '').length !== CLIENT_ID_LEN) {
      throw new DuoError('config_client_id',
        `client_id must be ${CLIENT_ID_LEN} characters`);
    }
    if (String(clientSecret || '').length !== CLIENT_SECRET_LEN) {
      throw new DuoError('config_client_secret',
        `client_secret must be ${CLIENT_SECRET_LEN} characters`);
    }
    if (!redirectUri || !/^https?:\/\//.test(redirectUri)) {
      throw new DuoError('config_redirect_uri', 'redirect_uri must be an absolute URL');
    }
    this.apiHost = apiHost;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  get tokenEndpoint() { return `https://${this.apiHost}${TOKEN_PATH}`; }

  /** The client assertion both the health check and the token exchange carry. */
  assertion() {
    const now = Math.floor(Date.now() / 1000);
    return jwt({
      iss: this.clientId,
      sub: this.clientId,
      aud: this.tokenEndpoint,
      exp: now + ASSERTION_TTL_S,
      // Single-use marker. Duo rejects a replayed assertion, which is only
      // meaningful if this is actually random.
      jti: crypto.randomBytes(16).toString('hex'),
    }, this.clientSecret);
  }

  async post(url, params) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // Duo rejects requests without one.
          'user-agent': 'cre-deal-analyzer/1.0',
        },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Reached nothing. This is the ONLY class of failure a fail-open tenant
      // may be admitted on, so it is flagged distinctly from every answer Duo
      // could give.
      throw new DuoError('unreachable', `Duo did not answer: ${err.message}`,
        { reachable: false });
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new DuoError('bad_response', `Duo returned HTTP ${res.status} and no JSON`);
    }
    if (!res.ok || body.stat === 'FAIL') {
      // Duo's own message is carried for the operator log and never for the
      // browser; it can name the integration and the account.
      throw new DuoError('rejected',
        `Duo returned HTTP ${res.status}: ${body.message || body.error || 'no detail'}`);
    }
    return body;
  }

  /**
   * Ask Duo whether this integration works, before relying on it.
   *
   * Called by `npm run duo -- check` and at the start of a login when the
   * tenant fails closed. The second one is not redundant: the health check is
   * what distinguishes "Duo is down" from "Duo is up and this user failed",
   * which is exactly the distinction the fail mode turns on. Without it, a
   * fail-open tenant would admit users whose second factor Duo had actively
   * refused.
   */
  async healthCheck() {
    const body = await this.post(`https://${this.apiHost}${HEALTH_PATH}`, {
      client_assertion: this.assertion(),
      client_id: this.clientId,
    });
    if (body.stat !== 'OK') {
      throw new DuoError('unhealthy', `Duo health check returned ${body.stat}`);
    }
    return true;
  }

  /**
   * Where to send the browser.
   *
   * The username travels inside a SIGNED request object, not as a query
   * parameter, so it cannot be edited in the address bar between here and Duo.
   */
  authUrl({ username, state }) {
    if (!username) throw new DuoError('no_username', 'a username is required');
    if (typeof state !== 'string' || state.length < STATE_MIN || state.length > STATE_MAX) {
      throw new DuoError('bad_state', `state must be ${STATE_MIN}-${STATE_MAX} characters`);
    }
    const now = Math.floor(Date.now() / 1000);
    const request = jwt({
      response_type: 'code',
      scope: 'openid',
      exp: now + ASSERTION_TTL_S,
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state,
      duo_uname: username,
      iss: this.clientId,
      aud: `https://${this.apiHost}`,
      // Returns the authorization code as `duo_code` rather than `code`, so it
      // cannot be confused with an OAuth code from the identity provider in a
      // log, a handler, or a reader's head.
      use_duo_code_attribute: true,
    }, this.clientSecret);

    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      request,
      scope: 'openid',
      redirect_uri: this.redirectUri,
      state,
    });
    return `https://${this.apiHost}${AUTH_PATH}?${q}`;
  }

  /**
   * Exchange the code for a verified result.
   *
   * @param {string} code             the `duo_code` from the callback
   * @param {string} expectedUsername who the pending login is for. REQUIRED —
   *   see the note at the top of the file for what skipping this comparison
   *   costs.
   */
  async exchange(code, expectedUsername) {
    if (!code || typeof code !== 'string') {
      throw new DuoError('no_code', 'no authorization code');
    }
    if (!expectedUsername) {
      // A programming error, and one that would silently disable the entire
      // control, so it is a throw rather than a default.
      throw new DuoError('no_expected_username',
        'exchange() requires the username the challenge was issued for');
    }

    const body = await this.post(this.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: this.assertion(),
    });

    if (!body.id_token) throw new DuoError('no_id_token', 'Duo returned no id_token');
    const claims = verifyJwt(body.id_token, this.clientSecret);

    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== this.tokenEndpoint) {
      throw new DuoError('token_issuer', `id_token iss is ${claims.iss}`);
    }
    // `aud` may be a string or an array; both spellings are valid JWT.
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.clientId)) {
      throw new DuoError('token_audience', 'id_token is not addressed to this client');
    }
    if (typeof claims.exp !== 'number' || claims.exp < now) {
      throw new DuoError('token_expired', 'id_token has expired');
    }
    if (typeof claims.iat !== 'number' || claims.iat > now + LEEWAY_S) {
      throw new DuoError('token_iat', 'id_token was issued in the future');
    }

    // THE CHECK. Compared case-insensitively because directories and Duo
    // disagree about case on usernames, and in constant time because it is a
    // comparison against an attacker-influenced value.
    const got = String(claims.preferred_username || '').toLowerCase();
    const want = String(expectedUsername).toLowerCase();
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(want, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new DuoError('username_mismatch',
        `Duo authenticated ${JSON.stringify(got)} but the pending login is for `
        + `${JSON.stringify(want)}`);
    }

    return {
      username: got,
      // Duo's own record of what happened, kept for the audit entry. Shapes
      // vary by Duo edition, so it is read defensively rather than destructured.
      result: claims.auth_result?.result || null,
      status: claims.auth_result?.status || null,
      device: claims.auth_device?.name || null,
      authTime: typeof claims.auth_time === 'number' ? claims.auth_time : null,
    };
  }
}

module.exports = { DuoClient, DuoError, verifyJwt, jwt, API_HOST, STATE_MIN, STATE_MAX };
