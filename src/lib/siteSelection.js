/**
 * Site selection — find markets near a subject deal that score better than
 * where the capital is currently pointed.
 *
 * The output is deliberately comparative rather than absolute. "Conroe scores
 * 71" is not actionable; "Conroe scores 71 against Houston's 58, driven by a
 * thinner supply pipeline and a lower tax burden, 41 miles away" is.
 */

import { markets as defaultMarkets, findMarket, distanceMiles } from './markets';
import { scoreMarket } from './marketScore';

/**
 * Rank markets within a radius of an origin.
 *
 * @param {Object|string} origin  A market record, or a free-text location.
 * @param {Object} opts
 * @param {string} opts.propertyType
 * @param {number} opts.radiusMiles  Default 250.
 * @param {number} opts.limit        Default 10.
 * @param {boolean} opts.excludeOrigin
 * @param {Object} opts.weights      Optional fitted weight vector.
 * @returns {{origin:Object|null, candidates:Array, unresolved?:boolean}}
 */
export function rankNearbyMarkets(origin, {
  propertyType = 'carwash',
  radiusMiles = 250,
  limit = 10,
  excludeOrigin = true,
  peers = defaultMarkets,
  weights = null,
} = {}) {
  const originMarket = typeof origin === 'string' ? findMarket(origin) : origin;

  if (!originMarket) {
    // Do not silently fall back to an arbitrary centroid — an unresolved
    // location is a real state the UI has to render.
    return { origin: null, candidates: [], unresolved: true };
  }

  const originScore = scoreMarket(originMarket, { propertyType, peers, weights });

  const candidates = peers
    .filter((m) => !(excludeOrigin && m.key === originMarket.key))
    .map((m) => {
      const distance = distanceMiles(originMarket, m);
      const scored = scoreMarket(m, { propertyType, peers, weights });
      return {
        market: m,
        distance,
        ...scored,
        scoreDelta: scored.score - originScore.score,
        // The two features that most differentiate this market from the origin,
        // which is what a user actually wants to read in a ranked list.
        differentiators: differentiate(scored, originScore),
      };
    })
    .filter((c) => c.distance <= radiusMiles)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { origin: { market: originMarket, ...originScore }, candidates };
}

/** The features where two scored markets diverge most. */
function differentiate(candidate, reference, count = 2) {
  const refByKey = new Map(reference.contributions.map((c) => [c.key, c]));
  return candidate.contributions
    .map((c) => {
      const ref = refByKey.get(c.key);
      return { key: c.key, label: c.label, unit: c.unit, delta: c.contribution - (ref?.contribution ?? 0), candidateValue: c.raw, referenceValue: ref?.raw ?? null };
    })
    .filter((d) => Number.isFinite(d.delta))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, count);
}

/**
 * Expansion candidates: nearby markets that outscore the subject by a
 * meaningful margin. Thresholded so the UI does not present noise as signal.
 */
export function expansionCandidates(origin, opts = {}) {
  const { minScoreDelta = 5 } = opts;
  const { origin: originScored, candidates, unresolved } = rankNearbyMarkets(origin, opts);
  if (unresolved) return { origin: null, candidates: [], unresolved: true };
  return {
    origin: originScored,
    candidates: candidates.filter((c) => c.scoreDelta >= minScoreDelta),
  };
}
