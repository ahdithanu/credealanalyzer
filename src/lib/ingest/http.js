/**
 * The one place this codebase talks to the internet.
 *
 * Isolated behind an injectable seam for a specific reason: the environment
 * these providers were written in could not reach any external host, so not one
 * line of them has ever made a real call. Everything except the socket is
 * tested against recorded response shapes, and the socket is the part you have
 * to verify yourself — `npm run enrich -- --probe` exists for that.
 *
 * An adapter nobody has pointed at its endpoint is a guess with a function
 * signature. Saying so here is more useful than a comment claiming it works.
 */

/** Default timeout. A screening pass should not hang on a slow state server. */
export const TIMEOUT_MS = 20_000;

export class FetchError extends Error {
  /**
   * @param {string} code      stable, safe to branch on
   * @param {string} message
   * @param {object} [context] url and status, for the report
   */
  constructor(code, message, context = {}) {
    super(message);
    this.code = code;
    Object.assign(this, context);
  }
}

/**
 * GET JSON.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  injected in tests; defaults to global fetch
 * @param {number}  [opts.timeoutMs]
 */
export async function getJson(url, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        // Several state ArcGIS servers refuse a request with no user agent.
        'user-agent': 'cre-deal-analyzer/1.0 (property screening)',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Unreachable is distinct from refused, because only one of them means the
    // data does not exist. A provider that cannot be reached leaves the field
    // unknown; a provider that answered "no such place" is an answer.
    throw new FetchError('unreachable', `${url} did not answer: ${err.message}`, { url });
  }

  if (!res.ok) {
    throw new FetchError('http_error', `${url} returned HTTP ${res.status}`,
      { url, status: res.status });
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    /**
     * A 200 carrying HTML is the signature failure of these endpoints: an
     * ArcGIS service that moved answers with a redirect to a portal page, and
     * a JSON parse error on a 200 is the only evidence. Reported as its own
     * code so the enrichment can say "this endpoint is wrong" rather than
     * "this property has no traffic count".
     */
    throw new FetchError('not_json',
      `${url} returned ${res.status} but not JSON (${text.slice(0, 80).replace(/\s+/g, ' ')}…)`,
      { url, status: res.status });
  }
}

/** Miles to metres, for the spatial queries below. */
export const MILES_TO_M = 1609.344;

/**
 * Great-circle distance in miles.
 *
 * Used to filter tract centroids to a radius. Haversine rather than a planar
 * approximation: at 3 miles the difference is metres, but the same helper gets
 * reached for at 10 and 25 miles, where a flat-earth approximation drifts
 * enough to move a tract in or out of the set.
 */
export function haversineMiles(a, b) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
