/**
 * Outbound HTTP.
 *
 * The pipeline's parsers and stages are pure; this is the only module that
 * touches the network, and it is where every unpleasant property of the real
 * world is handled once rather than in each adapter.
 *
 * What it does beyond calling fetch:
 *
 *   allowlist    only registered source hosts are reachable. Source URLs are
 *                built from a registry today, but the moment a county endpoint
 *                comes from configuration an unvalidated fetch is an SSRF, and
 *                that is not a change anyone remembers to guard later.
 *   secrets      injected at request time, never stored on the descriptor,
 *                and redacted from every log line and error message.
 *   timeouts     a hung county server must not hold a run open forever.
 *   conditional  ETag / Last-Modified, so an unchanged annual roll costs one
 *                304 rather than a re-download of the whole file.
 *   breaker      a source that is down fails fast instead of consuming the
 *                run's entire retry budget.
 *   accept       json, text and binary. A tax roll is a zip of pipe-delimited
 *                text; calling .json() on it is not a small mistake.
 */

/** Query parameters and headers whose values must never reach a log. */
const SECRET_PARAMS = /^(key|api_key|apikey|registrationkey|token|access_token|subscription-key)$/i;
const SECRET_HEADERS = /^(authorization|x-api-key|ocp-apim-subscription-key|cookie)$/i;

/** Mask secret values in a URL so it is safe to log or attach to an error. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const [k] of [...u.searchParams]) {
      if (SECRET_PARAMS.test(k)) u.searchParams.set(k, '[redacted]');
    }
    return u.toString();
  } catch {
    return String(url).replace(/([?&](?:key|token|registrationkey)=)[^&]+/gi, '$1[redacted]');
  }
}

export function redactHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, SECRET_HEADERS.test(k) ? '[redacted]' : v]),
  );
}

/** Redact any known secret value wherever it appears in a string. */
export function redactSecrets(text, secrets = {}) {
  let out = String(text ?? '');
  for (const v of Object.values(secrets)) {
    if (typeof v === 'string' && v.length >= 6) out = out.split(v).join('[redacted]');
  }
  return out;
}

export class TransportError extends Error {
  constructor(message, { url, status, retryable = false, cause } = {}) {
    super(message);
    this.name = 'TransportError';
    this.url = url ? redactUrl(url) : null;
    this.status = status ?? null;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/** In-memory conditional-request cache. Swap for Redis or a file store. */
export class MemoryHttpCache {
  constructor() { this.entries = new Map(); }
  get(key) { return this.entries.get(key) ?? null; }
  set(key, entry) { this.entries.set(key, entry); }
  get size() { return this.entries.size; }
}

/**
 * Per-host circuit breaker.
 *
 * closed  -> requests flow; consecutive failures counted
 * open    -> fail fast until cooldown elapses
 * half    -> one trial request; success closes, failure re-opens
 */
export function createBreaker({ threshold = 5, cooldownMs = 60_000, now = () => Date.now() } = {}) {
  const hosts = new Map();
  const stateOf = (host) => {
    if (!hosts.has(host)) hosts.set(host, { failures: 0, openedAt: null, trial: false });
    return hosts.get(host);
  };
  return {
    check(host) {
      const s = stateOf(host);
      if (s.openedAt === null) return 'closed';
      if (now() - s.openedAt < cooldownMs) return 'open';
      s.trial = true;
      return 'half';
    },
    succeed(host) {
      const s = stateOf(host);
      s.failures = 0; s.openedAt = null; s.trial = false;
    },
    fail(host) {
      const s = stateOf(host);
      s.failures++;
      if (s.trial || s.failures >= threshold) { s.openedAt = now(); s.trial = false; }
    },
    state(host) { return stateOf(host); },
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the outbound transport.
 *
 * @param {Object}   opts
 * @param {Function} opts.fetchImpl     global fetch in production, a fake in tests
 * @param {string[]} opts.allowedHosts  exact hostnames this pipeline may reach
 * @param {string}   opts.userAgent     polite identification, with a contact address
 * @param {Object}   opts.secrets       values redacted from every log and error
 */
export function createTransport({
  fetchImpl,
  allowedHosts,
  userAgent,
  secrets = {},
  timeoutMs = 30_000,
  minIntervalMs = 0,
  maxRetries = 3,
  cache = new MemoryHttpCache(),
  breaker = createBreaker(),
  onEvent = () => {},
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createTransport needs a fetchImpl');
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    throw new Error('createTransport needs an explicit allowedHosts list');
  }
  if (!userAgent) {
    // Public data providers rate-limit or block anonymous clients, and an
    // unidentified crawler on a county server is how an IP gets banned.
    throw new Error('createTransport needs a userAgent identifying the caller');
  }

  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const lastByHost = new Map();

  return async function request({
    url, method = 'GET', headers = {}, body = null, accept = 'json',
    sourceId = null, conditional = true,
  }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new TransportError('malformed url', { url });
    }
    if (parsed.protocol !== 'https:') {
      throw new TransportError(`refusing non-https request to ${parsed.protocol}//`, { url });
    }
    const host = parsed.hostname.toLowerCase();
    if (!allowed.has(host)) {
      // The guard that matters: a URL that ever becomes data-driven cannot
      // reach anything the operator did not register.
      throw new TransportError(`host not on the egress allowlist: ${host}`, { url });
    }

    const breakerState = breaker.check(host);
    if (breakerState === 'open') {
      throw new TransportError(`circuit open for ${host}`, { url, retryable: false });
    }

    const cacheKey = `${method} ${url}`;
    const cached = conditional ? cache.get(cacheKey) : null;

    const outHeaders = { 'user-agent': userAgent, ...headers };
    if (cached?.etag) outHeaders['if-none-match'] = cached.etag;
    else if (cached?.lastModified) outHeaders['if-modified-since'] = cached.lastModified;

    let attempt = 0;
    for (;;) {
      const wait = (lastByHost.get(host) ?? 0) + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastByHost.set(host, now());

      const startedAt = now();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

      try {
        const res = await fetchImpl(url, {
          method, headers: outHeaders,
          body: body === null ? undefined : body,
          signal: controller?.signal,
        });

        if (timer) clearTimeout(timer);
        const durationMs = now() - startedAt;

        if (res.status === 304 && cached) {
          breaker.succeed(host);
          onEvent({ type: 'not-modified', sourceId, url: redactUrl(url), status: 304, durationMs });
          return { status: 304, body: cached.body, notModified: true, fromCache: true, bytes: cached.bytes, durationMs };
        }

        if (res.status === 429 || res.status >= 500) {
          throw new TransportError(`upstream ${res.status}`, { url, status: res.status, retryable: true });
        }
        if (!res.ok) {
          throw new TransportError(`upstream ${res.status}`, { url, status: res.status, retryable: false });
        }

        const payload = await readBody(res, accept);
        breaker.succeed(host);

        if (conditional) {
          const etag = header(res, 'etag');
          const lastModified = header(res, 'last-modified');
          if (etag || lastModified) {
            cache.set(cacheKey, { etag, lastModified, body: payload.body, bytes: payload.bytes });
          }
        }

        onEvent({
          type: 'ok', sourceId, url: redactUrl(url), method, status: res.status,
          bytes: payload.bytes, durationMs, attempt,
          headers: redactHeaders(outHeaders),
        });

        return { status: res.status, body: payload.body, bytes: payload.bytes, notModified: false, fromCache: false, durationMs };
      } catch (err) {
        if (timer) clearTimeout(timer);
        const aborted = err?.name === 'AbortError';
        const wrapped = err instanceof TransportError
          ? err
          : new TransportError(
              redactSecrets(aborted ? `timed out after ${timeoutMs}ms` : (err?.message ?? 'request failed'), secrets),
              { url, retryable: aborted || isNetworkError(err), cause: err },
            );

        attempt++;
        const willRetry = wrapped.retryable && attempt <= maxRetries;
        onEvent({
          type: willRetry ? 'retry' : 'error', sourceId, url: redactUrl(url),
          status: wrapped.status, attempt, error: redactSecrets(wrapped.message, secrets),
        });

        if (!willRetry) { breaker.fail(host); throw wrapped; }
        // Exponential backoff with jitter, so a fleet does not retry in lockstep.
        await sleep(2 ** attempt * 100 + Math.floor((attempt * 37) % 100));
      }
    }
  };
}

function header(res, name) {
  if (typeof res.headers?.get === 'function') return res.headers.get(name);
  return res.headers?.[name] ?? null;
}

async function readBody(res, accept) {
  if (accept === 'json') {
    const text = await res.text();
    try {
      return { body: JSON.parse(text), bytes: text.length };
    } catch (err) {
      // A provider returning an HTML error page with a 200 is common enough
      // that the message has to say what actually arrived.
      throw new TransportError(`expected json, got ${text.slice(0, 60).replace(/\s+/g, ' ')}…`, { status: res.status });
    }
  }
  if (accept === 'text') {
    const text = await res.text();
    return { body: text, bytes: text.length };
  }
  if (accept === 'binary') {
    const buf = await res.arrayBuffer();
    return { body: buf, bytes: buf.byteLength ?? 0 };
  }
  throw new TransportError(`unknown accept mode: ${accept}`);
}

function isNetworkError(err) {
  const code = err?.code ?? '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code)
    || /network|socket|fetch failed/i.test(err?.message ?? '');
}
