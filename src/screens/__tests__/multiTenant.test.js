/**
 * The multi-tenant frontend path.
 *
 * Every other test in this directory runs in SINGLE-USER mode, where
 * REACT_APP_API_URL is unset and the app behaves as it did before there was a
 * server. That is deliberate — it keeps those 1057 tests meaningful — but it
 * means nothing covered the gate, the session, or the API-backed store until
 * this file.
 *
 * The modules read REACT_APP_API_URL at import time, so each test resets the
 * registry after setting it. That is the cost of a constant that cannot change
 * under a running app, which is the property we want: see dealStore.js.
 */

const API = 'https://api.test.example';

/**
 * Load the app fresh with the API configured, and a scripted fetch.
 *
 * React, the render harness AND the app all come from the module registry
 * created by this resetModules() call. Importing the harness at the top of the
 * file instead gives it the ORIGINAL React while the app gets a fresh one, and
 * two React copies means every hook reads a null dispatcher — "Cannot read
 * properties of null (reading 'useState')", which looks like a broken component
 * and is really a broken test setup.
 */
function loadMultiTenant(handlers) {
  jest.resetModules();
  process.env.REACT_APP_API_URL = API;

  const calls = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || 'GET', init });
    const handler = handlers[`${init.method || 'GET'} ${u.pathname}`]
      ?? handlers[u.pathname];
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    return handler(init, u);
  });

  /* eslint-disable global-require */
  const React = require('react');
  const harness = require('../testing/renderScreen');
  const mod = require('../../App');
  /* eslint-enable global-require */
  return { App: mod.default, calls, React, ...harness };
}

const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const unauthorized = async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthenticated' }) });

const SESSION = {
  user: { id: 'u1', email: 'analyst@firmx.com', name: 'An Analyst', role: 'analyst' },
  tenant: { id: 't1', slug: 'firm-x', name: 'Firm X' },
  csrfToken: 'csrf-abc',
  expiresAt: new Date(Date.now() + 3600e3).toISOString(),
};

/**
 * Let the mount effect, its fetch, and the resulting state update all land.
 *
 * One tick is not enough and the failure is confusing: the container renders
 * EMPTY, because the effect has fired but the promise it awaits has not
 * resolved, so neither the gate nor the app has decided what to draw yet.
 */
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 0));
  }
};

afterEach(() => {
  delete process.env.REACT_APP_API_URL;
  jest.resetModules();
  delete global.fetch;
});

describe('the sign-in gate', () => {
  it('shows the sign-in screen, and NO deal data, when not authenticated', async () => {
    const { App, React, renderScreen, text } = loadMultiTenant({ '/auth/me': unauthorized });
    const r = renderScreen(React.createElement(App));
    await settle();
    try {
      const body = text(r.container);
      expect(body).toMatch(/Continue with SSO/);
      // The thing that must never leak onto an unauthenticated page. The sample
      // portfolio is seeded only in single-user mode; if it ever reaches here,
      // a visitor sees deal names before proving who they are.
      expect(body).not.toMatch(/Houston Express Tunnel|Alamo Ridge|Pipeline/);
    } finally { r.unmount(); }
  });

  it('never seeds the sample portfolio into a signed-in firm', async () => {
    // Nine fictional deals dropped into a client firm's audited pipeline is a
    // support call at best, and at worst a memo citing a deal that never was.
    const { App, React, renderScreen, text } = loadMultiTenant({
      '/auth/me': ok(SESSION),
      '/api/deals': ok({ deals: [] }),
    });
    const r = renderScreen(React.createElement(App));
    await settle();
    try {
      const body = text(r.container);
      expect(body).not.toMatch(/Houston Express Tunnel|Alamo Ridge|Katy Freeway/);
    } finally { r.unmount(); }
  });

  it('renders neither the app nor the sign-in screen while the session is in flight', async () => {
    // A login prompt flashed at someone already signed in, on every page load,
    // is what resolving `loading` into `anonymous` would produce.
    let release;
    const { App, React, renderScreen, text } = loadMultiTenant({
      '/auth/me': () => new Promise((res) => { release = () => res({ ok: true, status: 200, json: async () => SESSION }); }),
    });
    const r = renderScreen(React.createElement(App));
    try {
      expect(text(r.container)).not.toMatch(/Continue with SSO/);
      expect(r.container.querySelector('.app-booting')).toBeTruthy();
      release();
      await settle();
    } finally { r.unmount(); }
  });

  it('distinguishes an unreachable API from being signed out', async () => {
    // Reporting "signed out" for an outage shows a sign-in button that cannot
    // work, and clicking it navigates away from an app about to recover.
    const { App, React, renderScreen, text } = loadMultiTenant({});
    global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
    const r = renderScreen(React.createElement(App));
    await settle();
    try {
      expect(text(r.container)).toMatch(/Cannot reach the service/);
    } finally { r.unmount(); }
  });
});

describe('the signed-in shell', () => {
  it('names the firm whose data is on screen', async () => {
    // On a shared machine, or for a consultant with two clients, "whose
    // pipeline is this" must never be a guess.
    const { App, React, renderScreen, text } = loadMultiTenant({
      '/auth/me': ok(SESSION),
      '/api/deals': ok({ deals: [] }),
    });
    const r = renderScreen(React.createElement(App));
    await settle();
    try {
      expect(text(r.container)).toMatch(/Firm X/);
      expect(text(r.container)).toMatch(/Sign out/);
    } finally { r.unmount(); }
  });

  it('renders the firm\'s own deals', async () => {
    const { App, React, renderScreen, text } = loadMultiTenant({
      '/auth/me': ok(SESSION),
      '/api/deals': ok({
        deals: [{
          id: 'd1', name: 'Confidential Alpha', stage: 'IC Thursday',
          payload: {
            propertyType: 'multifamily', constructionType: 'acquisition',
            purchasePrice: 20000000, grossRevenue: 2400000, units: 100,
            holdPeriod: 5, exitCapRate: 5.6, location: 'Dallas, TX',
          },
          updated_at: new Date().toISOString(),
        }],
      }),
    });
    const r = renderScreen(React.createElement(App));
    await settle();
    try {
      expect(text(r.container)).toMatch(/Confidential Alpha/);
    } finally { r.unmount(); }
  });
});

describe('the API client', () => {
  it('sends credentials on every request and the CSRF token only on writes', async () => {
    const { App, calls, React, renderScreen, text } = loadMultiTenant({
      '/auth/me': ok(SESSION),
      '/api/deals': ok({ deals: [] }),
    });
    const r = renderScreen(React.createElement(App));
    await settle();
    try {
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        // Without this the cookie is not sent and everything is a 401.
        expect(c.init.credentials).toBe('include');
        if (['GET', 'HEAD'].includes(c.method)) {
          expect(c.init.headers?.['x-csrf-token']).toBeUndefined();
        }
      }
    } finally { r.unmount(); }
  });

  it('never writes a session token into browser storage', async () => {
    // The session is an httpOnly cookie precisely so script cannot read it. Any
    // copy of a credential in localStorage would trade that protection away.
    const { App, React, renderScreen, text } = loadMultiTenant({
      '/auth/me': ok(SESSION),
      '/api/deals': ok({ deals: [] }),
    });
    const r = renderScreen(React.createElement(App));
    await settle();
    try {
      const dump = JSON.stringify({ ...window.localStorage });
      expect(dump).not.toMatch(/csrf-abc/);
      expect(dump).not.toMatch(/analyst@firmx\.com/);
    } finally { r.unmount(); }
  });
});

describe('remote persistence', () => {
  it('refuses to save the whole collection remotely', async () => {
    // Writing every deal on every keystroke would overwrite a colleague's
    // concurrent edit to a DIFFERENT deal with whatever this tab last read.
    jest.resetModules();
    process.env.REACT_APP_API_URL = API;
    // eslint-disable-next-line global-require
    const { dealStore } = require('../../lib/dealStore');
    expect(dealStore.mode).toBe('remote');
    await expect(dealStore.saveAll([])).rejects.toThrow(/per deal/);
  });

  it('strips derived values before sending a deal', async () => {
    // A stored metric survives an engine correction and becomes a stale number
    // that looks measured. Same rule storage.js applies locally.
    jest.resetModules();
    process.env.REACT_APP_API_URL = API;
    // eslint-disable-next-line global-require
    const { __internals } = require('../../lib/dealStore');
    const sent = __internals.toServer({
      id: 'd1', name: 'X', stage: 'Screening',
      purchasePrice: 1, metrics: { model: {} }, model: {}, updatedAt: 'x',
    });
    expect(sent.payload.metrics).toBeUndefined();
    expect(sent.payload.model).toBeUndefined();
    expect(sent.payload.id).toBeUndefined();
    expect(sent.payload.purchasePrice).toBe(1);
    expect(sent.name).toBe('X');
  });

  it('single-user mode is unaffected and still uses localStorage', async () => {
    jest.resetModules();
    delete process.env.REACT_APP_API_URL;
    // eslint-disable-next-line global-require
    const { dealStore } = require('../../lib/dealStore');
    expect(dealStore.mode).toBe('local');
  });
});
