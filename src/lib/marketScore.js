/**
 * Market opportunity scoring.
 *
 * Design stance: enterprise buyers will not underwrite against a black box. An
 * investment committee asks "why did this market score 82?" and the answer has
 * to be a decomposition, not a shrug. So the model is a linear scorecard over
 * peer-normalised features, and every score ships with its per-feature
 * contributions.
 *
 * That is also the right first model statistically. With a few dozen markets
 * and a handful of realised deals per firm, a regularised linear model over
 * hand-chosen features beats anything with more capacity, and it degrades
 * honestly instead of hallucinating structure.
 *
 * The learning path is `fitWeights`: once a firm has realised outcomes on its
 * own closed deals, ridge regression re-fits the weights against that history,
 * and the scorecard becomes proprietary to the firm. Until then the default
 * weights are a documented prior, labelled as such.
 */

import { markets as defaultMarkets, distanceMiles } from './markets';

/**
 * Feature definitions.
 *
 * `direction: 1` means higher raw values are more attractive; `-1` means lower.
 * Each direction is a modelling judgment and is stated so it can be argued with.
 */
export const FEATURES = [
  { key: 'popGrowth5y',      label: 'Population Growth',  direction:  1, unit: '%',   rationale: 'Demand growth underwrites absorption and rent growth.' },
  { key: 'employmentGrowth', label: 'Employment Growth',  direction:  1, unit: '%',   rationale: 'Job formation drives space demand across every property type.' },
  { key: 'medianHHI',        label: 'Median Income',      direction:  1, unit: '$',   rationale: 'Household income supports rent levels and discretionary spend.' },
  { key: 'supplyPipeline',   label: 'Supply Pipeline',    direction: -1, unit: '%',   rationale: 'Construction underway as a share of inventory. More competing supply compresses rents at delivery.' },
  { key: 'rentGrowth',       label: 'Rent Growth',        direction:  1, unit: '%',   rationale: 'Trailing market rent growth as a momentum signal.' },
  { key: 'effectiveTaxRate', label: 'Property Tax Burden',direction: -1, unit: '%',   rationale: 'A direct and permanent NOI drag; the single largest expense line in Texas.' },
  { key: 'trafficCount',     label: 'Traffic Count',      direction:  1, unit: 'AADT',rationale: 'Arterial volume. Decisive for car wash and small-format retail, weak for industrial.' },
  { key: 'population',       label: 'Market Scale',       direction:  1, unit: '',    rationale: 'Larger markets carry deeper buyer pools and better exit liquidity.' },
  { key: 'marketCapRate',    label: 'Exit Liquidity',     direction: -1, unit: '%',   rationale: 'Tighter market cap rates proxy institutional buyer depth. Note the tension: a lower cap rate means a richer exit but a more expensive basis.' },
];

/**
 * Default weights per property type. These are a documented prior, not a
 * fitted model — `provenance.fitted` is false until `fitWeights` replaces them.
 * Each column sums to 1.
 */
export const DEFAULT_WEIGHTS = {
  carwash:      { popGrowth5y: 0.14, employmentGrowth: 0.08, medianHHI: 0.16, supplyPipeline: 0.10, rentGrowth: 0.04, effectiveTaxRate: 0.10, trafficCount: 0.28, population: 0.05, marketCapRate: 0.05 },
  multifamily:  { popGrowth5y: 0.22, employmentGrowth: 0.18, medianHHI: 0.10, supplyPipeline: 0.22, rentGrowth: 0.12, effectiveTaxRate: 0.08, trafficCount: 0.00, population: 0.04, marketCapRate: 0.04 },
  office:       { popGrowth5y: 0.08, employmentGrowth: 0.30, medianHHI: 0.12, supplyPipeline: 0.18, rentGrowth: 0.10, effectiveTaxRate: 0.06, trafficCount: 0.00, population: 0.08, marketCapRate: 0.08 },
  retail:       { popGrowth5y: 0.16, employmentGrowth: 0.10, medianHHI: 0.20, supplyPipeline: 0.10, rentGrowth: 0.08, effectiveTaxRate: 0.08, trafficCount: 0.20, population: 0.04, marketCapRate: 0.04 },
  industrial:   { popGrowth5y: 0.12, employmentGrowth: 0.22, medianHHI: 0.04, supplyPipeline: 0.18, rentGrowth: 0.12, effectiveTaxRate: 0.12, trafficCount: 0.00, population: 0.12, marketCapRate: 0.08 },
};

/** Read a feature off a market record, resolving per-property-type fields. */
export function featureValue(market, key, propertyType) {
  if (key === 'marketCapRate') {
    return market.marketCapRate?.[propertyType] ?? null;
  }
  const v = market[key];
  return typeof v === 'number' ? v : null;
}

/**
 * Percentile rank of `value` within `values`, in [0, 1].
 *
 * Percentile rather than z-score: robust to the skewed, small-N distributions
 * these features actually have (metro population spans two orders of
 * magnitude), and directly interpretable to a non-technical user as
 * "80th percentile among peer markets".
 */
export function percentileRank(value, values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0 || typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (clean.length === 1) return 0.5;
  let below = 0;
  let equal = 0;
  for (const v of clean) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return (below + 0.5 * equal) / clean.length;
}

/**
 * Score one market for one property type against a peer set.
 *
 * score = 50 + Σ wᵢ · (pᵢ − 0.5) · 100
 *
 * where pᵢ is the direction-adjusted percentile of feature i. With weights
 * summing to 1 this is bounded to [0, 100] by construction, and 50 is exactly
 * "median across every feature" — so the number has a meaning, not just a rank.
 *
 * @returns {{score:number, contributions:Array, coverage:number, provenance:Object}}
 */
export function scoreMarket(market, {
  propertyType = 'carwash',
  peers = defaultMarkets,
  weights = null,
} = {}) {
  const w = weights?.weights || weights || DEFAULT_WEIGHTS[propertyType] || DEFAULT_WEIGHTS.carwash;
  const contributions = [];
  let usedWeight = 0;

  for (const feature of FEATURES) {
    const weight = w[feature.key] ?? 0;
    if (weight === 0) continue;

    const raw = featureValue(market, feature.key, propertyType);
    const peerValues = peers.map((m) => featureValue(m, feature.key, propertyType));
    const pct = percentileRank(raw, peerValues);
    if (pct === null) {
      contributions.push({ ...feature, weight, raw: null, percentile: null, contribution: 0, missing: true });
      continue;
    }

    // Direction-adjusted percentile: for a lower-is-better feature, being in
    // the 90th percentile of raw value is the 10th percentile of attractiveness.
    const adjusted = feature.direction === 1 ? pct : 1 - pct;
    const contribution = weight * (adjusted - 0.5) * 100;

    usedWeight += weight;
    contributions.push({
      key: feature.key,
      label: feature.label,
      unit: feature.unit,
      rationale: feature.rationale,
      direction: feature.direction,
      weight,
      raw,
      percentile: adjusted,
      rawPercentile: pct,
      contribution,
      missing: false,
    });
  }

  const total = contributions.reduce((s, c) => s + c.contribution, 0);
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const declaredWeight = Object.values(w).reduce((s, x) => s + x, 0);

  return {
    marketKey: market.key,
    propertyType,
    score: 50 + total,
    contributions,
    // Share of model weight actually backed by present data. The UI must show
    // this: a score built on 60% of its features is not the same claim.
    coverage: declaredWeight > 0 ? usedWeight / declaredWeight : 0,
    provenance: {
      fitted: Boolean(weights?.provenance?.fitted),
      model: weights?.provenance?.model || 'default-prior',
      dataQuality: market.provenance?.dataQuality || 'unknown',
    },
  };
}

/** Score every market in a peer set, ranked best first. */
export function scoreAll({ propertyType = 'carwash', peers = defaultMarkets, weights = null } = {}) {
  return peers
    .map((m) => ({ market: m, ...scoreMarket(m, { propertyType, peers, weights }) }))
    .sort((a, b) => b.score - a.score);
}

// ─── learning from realised outcomes ─────────────────────────────────────────

/** Solve A·x = b by Gauss-Jordan elimination with partial pivoting. */
function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null; // singular
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/**
 * Re-fit scorecard weights from a firm's own realised deal outcomes by ridge
 * regression on direction-adjusted feature percentiles.
 *
 * Ridge rather than OLS because these features are strongly collinear —
 * population growth, employment growth and rent growth move together — and OLS
 * on a few dozen deals would hand back wild, sign-flipped coefficients that
 * look authoritative and mean nothing. The L2 penalty shrinks toward the prior.
 *
 * @param {Array<{market:Object, propertyType:string, outcome:number}>} observations
 *        `outcome` is the realised metric to predict — typically levered IRR.
 * @param {Object} opts
 * @param {number} opts.lambda      Ridge penalty. Higher = closer to equal weights.
 * @param {number} opts.minObservations Refuse to fit below this. Default 12.
 * @returns {{weights:Object, provenance:Object}|{error:string}}
 */
export function fitWeights(observations, { lambda = 1.0, minObservations = 12, peers = defaultMarkets } = {}) {
  if (!Array.isArray(observations) || observations.length < minObservations) {
    return {
      error: 'insufficient-data',
      message:
        'Need at least ' + minObservations + ' realised deal outcomes to fit a firm-specific model. ' +
        'Using the default prior until then.',
      observations: observations?.length ?? 0,
      required: minObservations,
    };
  }

  const keys = FEATURES.map((f) => f.key);

  // Design matrix of direction-adjusted percentiles, centred on 0.5.
  const X = [];
  const y = [];
  for (const obs of observations) {
    if (typeof obs.outcome !== 'number' || !Number.isFinite(obs.outcome)) continue;
    const row = keys.map((key) => {
      const feature = FEATURES.find((f) => f.key === key);
      const raw = featureValue(obs.market, key, obs.propertyType);
      const peerValues = peers.map((m) => featureValue(m, key, obs.propertyType));
      const pct = percentileRank(raw, peerValues);
      if (pct === null) return 0;
      const adjusted = feature.direction === 1 ? pct : 1 - pct;
      return adjusted - 0.5;
    });
    X.push(row);
    y.push(obs.outcome);
  }

  if (X.length < minObservations) {
    return { error: 'insufficient-data', observations: X.length, required: minObservations };
  }

  const n = keys.length;
  const yMean = y.reduce((s, v) => s + v, 0) / y.length;

  // Normal equations with an L2 penalty: (XᵀX + λI)·w = Xᵀ(y − ȳ)
  const XtX = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => X.reduce((s, row) => s + row[i] * row[j], 0)),
  );
  for (let i = 0; i < n; i++) XtX[i][i] += lambda;
  const Xty = Array.from({ length: n }, (_, i) =>
    X.reduce((s, row, r) => s + row[i] * (y[r] - yMean), 0),
  );

  const beta = solve(XtX, Xty);
  if (!beta) return { error: 'singular-matrix', message: 'Features are perfectly collinear; raise lambda or drop a feature.' };

  // In-sample R², reported so the UI can refuse to present a weak model.
  let ssRes = 0;
  let ssTot = 0;
  for (let r = 0; r < X.length; r++) {
    const pred = yMean + X[r].reduce((s, v, i) => s + v * beta[i], 0);
    ssRes += (y[r] - pred) ** 2;
    ssTot += (y[r] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Renormalise to a weight vector summing to 1 by absolute magnitude, so the
  // fitted model plugs into the same bounded scorecard.
  const absSum = beta.reduce((s, v) => s + Math.abs(v), 0);
  const weights = {};
  keys.forEach((key, i) => { weights[key] = absSum > 0 ? Math.abs(beta[i]) / absSum : 1 / n; });

  // A negative coefficient means the firm's realised outcomes contradict the
  // feature's assumed direction. Surface it rather than burying it.
  const contradictions = keys.filter((key, i) => beta[i] < -1e-6).map((key) => ({
    key,
    label: FEATURES.find((f) => f.key === key).label,
    coefficient: beta[keys.indexOf(key)],
  }));

  return {
    weights,
    coefficients: Object.fromEntries(keys.map((k, i) => [k, beta[i]])),
    provenance: {
      fitted: true,
      model: 'ridge',
      lambda,
      observations: X.length,
      r2,
      contradictions,
      // In-sample R² on a few dozen points overstates skill. Hold-out
      // validation is required before this drives capital allocation.
      caveat: 'In-sample R². Validate out-of-sample before relying on this model.',
    },
  };
}
