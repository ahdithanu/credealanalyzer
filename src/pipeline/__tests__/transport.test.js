import {
  createTransport, createBreaker, MemoryHttpCache, TransportError,
  redactUrl, redactHeaders, redactSecrets,
} from '../transport';

const HOSTS = ['api.census.gov', 'api.bls.gov'];
const UA = 'cre-deal-analyzer/1.0 (data-ops@example.com)';
const noSleep = () => Promise.resolve();

const ok = (body, headers = {}) => ({
  ok: true, status: 200,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(8),
});

const status = (code, headers = {}) => ({
  ok: code < 400, status: code,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0),
});

const make = (fetchImpl, opts = {}) => createTransport({
  fetchImpl, allowedHosts: HOSTS, userAgent: UA, sleep: noSleep, ...opts,
});

describe('construction', () => {
  it('requires a fetch implementation, an allowlist and a user agent', () => {
    expect(() => createTransport({ allowedHosts: HOSTS, userAgent: UA })).toThrow(/fetchImpl/);
    expect(() => createTransport({ fetchImpl: () => {}, userAgent: UA })).toThrow(/allowedHosts/);
    // Anonymous clients get rate-limited or blocked, and an unidentified
    // crawler on a county server is how an IP ends up banned.
    expect(() => createTransport({ fetchImpl: () => {}, allowedHosts: HOSTS })).toThrow(/userAgent/);
  });
});

describe('egress allowlist', () => {
  it('refuses a host that is not registered', async () => {
    const req = make(async () => ok({}));
    await expect(req({ url: 'https://evil.example.com/x' })).rejects.toThrow(/not on the egress allowlist/);
  });

  it('refuses link-local metadata addresses', async () => {
    // The classic SSRF target the moment a URL becomes data-driven.
    const req = make(async () => ok({}));
    await expect(req({ url: 'https://169.254.169.254/latest/meta-data/' })).rejects.toThrow(/allowlist/);
  });

  it('refuses plain http', async () => {
    const req = make(async () => ok({}));
    await expect(req({ url: 'http://api.census.gov/data' })).rejects.toThrow(/non-https/);
  });

  it('refuses a malformed url', async () => {
    const req = make(async () => ok({}));
    await expect(req({ url: 'not a url' })).rejects.toThrow(/malformed/);
  });

  it('allows a registered host', async () => {
    const req = make(async () => ok({ hello: true }));
    await expect(req({ url: 'https://api.census.gov/data' })).resolves.toMatchObject({ status: 200 });
  });
});

describe('secret redaction', () => {
  it('masks known secret query parameters', () => {
    expect(redactUrl('https://api.census.gov/data?get=NAME&key=abc123secret'))
      .toBe('https://api.census.gov/data?get=NAME&key=%5Bredacted%5D');
  });

  it('masks authorization headers', () => {
    expect(redactHeaders({ authorization: 'Bearer abc', 'user-agent': 'x' }))
      .toEqual({ authorization: '[redacted]', 'user-agent': 'x' });
  });

  it('scrubs a secret value wherever it appears in text', () => {
    expect(redactSecrets('failed with key sk-live-9f2b', { BLS_API_KEY: 'sk-live-9f2b' }))
      .toBe('failed with key [redacted]');
  });

  it('never emits a secret in a log event', async () => {
    const events = [];
    const req = make(async () => ok({}), {
      secrets: { CENSUS_API_KEY: 'abc123secret' },
      onEvent: (e) => events.push(e),
    });
    await req({ url: 'https://api.census.gov/data?key=abc123secret' });
    expect(JSON.stringify(events)).not.toContain('abc123secret');
  });

  it('never emits a secret in an error message', async () => {
    const req = make(async () => { throw new Error('connect failed for key abc123secret'); }, {
      secrets: { CENSUS_API_KEY: 'abc123secret' }, maxRetries: 0,
    });
    await expect(req({ url: 'https://api.census.gov/data?key=abc123secret' }))
      .rejects.toThrow(/\[redacted\]/);
  });
});

describe('retries and timeouts', () => {
  it('retries a 429 then succeeds', async () => {
    let n = 0;
    const req = make(async () => (++n < 3 ? status(429) : ok({ done: true })));
    await expect(req({ url: 'https://api.bls.gov/x' })).resolves.toMatchObject({ status: 200 });
    expect(n).toBe(3);
  });

  it('does not retry a 404', async () => {
    let n = 0;
    const req = make(async () => { n++; return status(404); });
    await expect(req({ url: 'https://api.bls.gov/x' })).rejects.toThrow(/upstream 404/);
    expect(n).toBe(1);
  });

  it('aborts a hung request and reports the timeout', async () => {
    const req = make(async (_url, { signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }), { timeoutMs: 5, maxRetries: 0 });
    await expect(req({ url: 'https://api.bls.gov/x' })).rejects.toThrow(/timed out after 5ms/);
  });

  it('surfaces a non-json body instead of a confusing parse error', async () => {
    // A provider returning an HTML error page with a 200 is common enough.
    const req = make(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => '<html><body>Service unavailable</body></html>',
    }), { maxRetries: 0 });
    await expect(req({ url: 'https://api.bls.gov/x' })).rejects.toThrow(/expected json, got <html>/);
  });
});

describe('conditional requests', () => {
  it('stores an etag and sends it on the next call', async () => {
    const seen = [];
    const cache = new MemoryHttpCache();
    const req = make(async (_url, init) => {
      seen.push(init.headers['if-none-match'] ?? null);
      return ok({ v: 1 }, { etag: 'W/"abc"' });
    }, { cache });
    await req({ url: 'https://api.census.gov/data' });
    await req({ url: 'https://api.census.gov/data' });
    expect(seen).toEqual([null, 'W/"abc"']);
    expect(cache.size).toBe(1);
  });

  it('serves the cached body on a 304 without re-downloading', async () => {
    const cache = new MemoryHttpCache();
    let call = 0;
    const req = make(async () => (++call === 1 ? ok({ v: 1 }, { etag: '"a"' }) : status(304)), { cache });
    await req({ url: 'https://api.census.gov/data' });
    const second = await req({ url: 'https://api.census.gov/data' });
    expect(second.notModified).toBe(true);
    expect(second.body).toEqual({ v: 1 });
  });

  it('can be turned off per request', async () => {
    const seen = [];
    const cache = new MemoryHttpCache();
    const req = make(async (_url, init) => {
      seen.push(init.headers['if-none-match'] ?? null);
      return ok({}, { etag: '"a"' });
    }, { cache });
    await req({ url: 'https://api.census.gov/data' });
    await req({ url: 'https://api.census.gov/data', conditional: false });
    expect(seen[1]).toBeNull();
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures and then fails fast', async () => {
    let calls = 0;
    const req = make(async () => { calls++; return status(500); }, {
      maxRetries: 0, breaker: createBreaker({ threshold: 3, cooldownMs: 10_000 }),
    });
    for (let i = 0; i < 3; i++) {
      await expect(req({ url: 'https://api.bls.gov/x' })).rejects.toThrow();
    }
    const before = calls;
    await expect(req({ url: 'https://api.bls.gov/x' })).rejects.toThrow(/circuit open/);
    expect(calls).toBe(before);            // no upstream call was made
  });

  it('does not trip a healthy host because another is down', async () => {
    const breaker = createBreaker({ threshold: 1, cooldownMs: 10_000 });
    const req = make(async (url) => (url.includes('bls') ? status(500) : ok({ fine: true })), {
      maxRetries: 0, breaker,
    });
    await expect(req({ url: 'https://api.bls.gov/x' })).rejects.toThrow();
    await expect(req({ url: 'https://api.census.gov/x' })).resolves.toMatchObject({ status: 200 });
  });

  it('half-opens after the cooldown and closes on success', async () => {
    let clock = 0;
    const now = () => clock;
    const breaker = createBreaker({ threshold: 1, cooldownMs: 1000, now });
    let healthy = false;
    const req = make(async () => (healthy ? ok({ up: true }) : status(500)), {
      maxRetries: 0, breaker, now,
    });
    await expect(req({ url: 'https://api.bls.gov/x' })).rejects.toThrow();
    expect(breaker.check('api.bls.gov')).toBe('open');
    clock = 2000;
    healthy = true;
    await expect(req({ url: 'https://api.bls.gov/x' })).resolves.toMatchObject({ status: 200 });
    expect(breaker.check('api.bls.gov')).toBe('closed');
  });
});

describe('observability', () => {
  it('emits a structured event per request', async () => {
    const events = [];
    const req = make(async () => ok({ a: 1 }), { onEvent: (e) => events.push(e) });
    await req({ url: 'https://api.census.gov/data', sourceId: 'census.acs5' });
    expect(events[0]).toMatchObject({ type: 'ok', sourceId: 'census.acs5', status: 200 });
    expect(events[0].bytes).toBeGreaterThan(0);
  });

  it('emits retry events before the terminal error', async () => {
    const events = [];
    const req = make(async () => status(503), { maxRetries: 2, onEvent: (e) => events.push(e) });
    await expect(req({ url: 'https://api.bls.gov/x' })).rejects.toThrow();
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('identifies itself with the configured user agent', async () => {
    let sent = null;
    const req = make(async (_url, init) => { sent = init.headers['user-agent']; return ok({}); });
    await req({ url: 'https://api.census.gov/data' });
    expect(sent).toBe(UA);
  });
});

describe('accept modes', () => {
  it('reads a binary body without attempting json', async () => {
    const req = make(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(64),
      text: async () => { throw new Error('should not read binary as text'); },
    }));
    const res = await req({ url: 'https://api.census.gov/roll.zip', accept: 'binary' });
    expect(res.bytes).toBe(64);
    expect(res.body.byteLength).toBe(64);
  });

  it('reads a text body verbatim', async () => {
    const req = make(async () => ({
      ok: true, status: 200, headers: { get: () => null }, text: async () => 'a|b\n1|2',
    }));
    expect((await req({ url: 'https://api.census.gov/x.csv', accept: 'text' })).body).toBe('a|b\n1|2');
  });

  it('rejects an unknown accept mode', async () => {
    const req = make(async () => ok({}), { maxRetries: 0 });
    await expect(req({ url: 'https://api.census.gov/x', accept: 'xml' })).rejects.toThrow(/unknown accept mode/);
  });
});

describe('POST', () => {
  it('sends the method, headers and body through', async () => {
    let seen = null;
    const req = make(async (_url, init) => { seen = init; return ok({ ok: true }); });
    await req({
      url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/',
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seriesid: ['X'] }),
    });
    expect(seen.method).toBe('POST');
    expect(seen.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen.body).seriesid).toEqual(['X']);
  });
});
