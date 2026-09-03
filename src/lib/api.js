/**
 * The API client.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: hold the session token. The token is
 * an httpOnly cookie the browser attaches on its own, and JavaScript cannot read
 * it — which is the point. An XSS bug in this app can make requests AS the user
 * while the page is open, but it cannot exfiltrate a credential that keeps
 * working after the tab closes. Anything here that stashed a token in
 * localStorage would trade that away for nothing.
 *
 * So the only thing held in memory is the CSRF token, which is not secret from
 * the legitimate page and is useless without the cookie.
 */

/**
 * The API origin. Unset means SINGLE-USER MODE: no server, deals in
 * localStorage, exactly as the app behaved before there was an API. That is a
 * real supported mode (a solo analyst, a laptop demo, the test suite), not a
 * fallback that happens to work — see dealStore.js.
 */
export const API_URL = (process.env.REACT_APP_API_URL || '').replace(/\/$/, '');

export const isMultiTenant = () => API_URL !== '';

/** Thrown for any non-2xx response, carrying the status so callers can branch. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let csrfToken = null;

/** Set from the /auth/me response. In memory only — never persisted. */
export function setCsrfToken(token) { csrfToken = token || null; }
export function getCsrfToken() { return csrfToken; }

async function request(path, { method = 'GET', body, signal } = {}) {
  if (!API_URL) throw new ApiError(0, 'no_api', 'No API is configured');

  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Only on state-changing methods, matching what the server checks. Sending it
  // on GETs would be harmless but would suggest it does something there.
  if (!['GET', 'HEAD'].includes(method) && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    // Without this the session cookie is not sent and every request is a 401.
    // The server's CORS policy names this exact origin, because a credentialed
    // request cannot use a wildcard — so a misconfiguration shows up as total
    // failure rather than as a quiet hole.
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (res.status === 204) return null;

  let payload = null;
  try { payload = await res.json(); } catch { /* a body is not guaranteed */ }

  if (!res.ok) {
    throw new ApiError(res.status, payload?.error, payload?.errors?.join('; '));
  }
  return payload;
}

export const api = {
  /**
   * Who am I. Returns null when not signed in rather than throwing, because
   * "not signed in" is the ordinary first answer on every page load and is not
   * an error condition.
   */
  async me() {
    try {
      const body = await request('/auth/me');
      setCsrfToken(body.csrfToken);
      return body;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setCsrfToken(null);
        return null;
      }
      throw err;
    }
  },

  /**
   * Begin SSO. A full-page navigation, NOT fetch: the browser has to follow the
   * redirect to the identity provider, land on the IdP's own page, and come
   * back — none of which a fetch can do, and all of which the user must see to
   * know which directory is asking for their credentials.
   */
  signIn({ org, next } = {}) {
    const u = new URL(`${API_URL}/auth/start`);
    if (org) u.searchParams.set('org', org);
    // Relative only. The server constrains this too, but sending an absolute
    // URL from here would be this app asking to be an open redirect.
    if (next && next.startsWith('/') && !next.startsWith('//')) {
      u.searchParams.set('next', next);
    }
    window.location.assign(u.toString());
  },

  async signOut() {
    await request('/auth/logout', { method: 'POST' });
    setCsrfToken(null);
  },

  listDeals: () => request('/api/deals').then((r) => r.deals),
  createDeal: (deal) => request('/api/deals', { method: 'POST', body: deal }).then((r) => r.deal),
  updateDeal: (id, deal) => request(`/api/deals/${id}`, { method: 'PUT', body: deal }).then((r) => r.deal),
  deleteDeal: (id) => request(`/api/deals/${id}`, { method: 'DELETE' }),
};

export const __internals = { request };
