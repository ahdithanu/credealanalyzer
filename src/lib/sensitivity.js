/**
 * Sensitivity, scenarios and breakeven.
 *
 * Every figure re-runs the full monthly model rather than perturbing a closed
 * form, so a sensitivity cell and the deal page can never disagree.
 */

import { runModel } from './finance';

/** Variables a user can flex, and how each maps onto the deal inputs. */
export const VARIABLES = {
  exitCapRate:      { label: 'Exit cap rate',     unit: '%',   step: 0.25, apply: (d, v) => ({ ...d, exitCapRate: v }),      read: (d) => d.exitCapRate },
  interestRate:     { label: 'Interest rate',     unit: '%',   step: 0.25, apply: (d, v) => ({ ...d, interestRate: v }),     read: (d) => d.interestRate },
  constructionCost: { label: 'Construction cost', unit: '$',   step: null, apply: (d, v) => ({ ...d, constructionCost: v }), read: (d) => d.constructionCost },
  grossRevenue:     { label: 'Gross revenue',     unit: '$',   step: null, apply: (d, v) => ({ ...d, grossRevenue: v }),     read: (d) => d.grossRevenue },
  vacancyRate:      { label: 'Vacancy',           unit: '%',   step: 1,    apply: (d, v) => ({ ...d, vacancyRate: v }),      read: (d) => d.vacancyRate },
  operatingExpenseRatio: { label: 'OpEx ratio',   unit: '%',   step: 2,    apply: (d, v) => ({ ...d, operatingExpenseRatio: v }), read: (d) => d.operatingExpenseRatio },
  downPayment:      { label: 'Equity share',      unit: '%',   step: 5,    apply: (d, v) => ({ ...d, downPayment: v }),      read: (d) => d.downPayment },
  holdPeriod:       { label: 'Hold period',       unit: 'yrs', step: 1,    apply: (d, v) => ({ ...d, holdPeriod: v }),       read: (d) => d.holdPeriod },
};

/**
 * Metrics a sensitivity can be measured in.
 *
 * `polarity` is +1 when a higher value is a better deal and -1 when it is a
 * worse one. Every metric here was higher-is-better until break-even occupancy
 * arrived, so the tornado exhibit hard-coded that direction into its colours
 * and painted the outcome that halves the covenant cushion green. Direction is
 * a property of the metric, so it is declared with the metric.
 */
export const METRICS = {
  leveredIRR:      { label: 'Levered IRR',    format: 'pct', polarity: 1, get: (m) => m.returns.leveredIRR },
  unleveredIRR:    { label: 'Unlevered IRR',  format: 'pct', polarity: 1, get: (m) => m.returns.unleveredIRR },
  equityMultiple:  { label: 'Equity multiple',format: 'x',   polarity: 1, get: (m) => m.returns.equityMultiple },
  yieldOnCost:     { label: 'Yield on cost',  format: 'pct', polarity: 1, get: (m) => m.operating.yieldOnCost },
  // Both of these are RATIOS on model.operating — 0.83 occupancy, 0.0685 cap
  // rate — and 'pct' is the tag that scales a ratio by 100 on the way to the
  // screen. calculateMetrics() carries a percent-scaled twin of the cap rate
  // (6.85) for the flat metric bag; reading that one here would print 685%,
  // and tagging these anything else would print break-even as "0.83%".
  goingInCapRate:  { label: 'Going-in cap rate', format: 'pct', polarity: 1, get: (m) => m.operating.goingInCapRate },
  // Not a return measure: it is the occupancy at which the asset stops paying
  // its own bills, so a rising value is a worse deal. Flexing it against rate
  // or opex is how the cushion over underwritten occupancy gets tested.
  breakEvenOccupancy: { label: 'Break-even occupancy', format: 'pct', polarity: -1, get: (m) => m.operating.breakEvenOccupancy },
  developmentSpreadBps: { label: 'Dev spread', format: 'bps', polarity: 1, get: (m) => m.operating.developmentSpreadBps },
  minDSCR:         { label: 'Min DSCR (incl. lease-up)', format: 'x', polarity: 1, get: (m) => m.operating.minDSCR },
  minStabilizedDSCR: { label: 'Min DSCR (stabilized)',   format: 'x', polarity: 1, get: (m) => m.operating.minStabilizedDSCR },
  profit:          { label: 'Profit',         format: '$',   polarity: 1, get: (m) => m.returns.profit },
};

function evaluate(deal, metric) {
  try {
    return METRICS[metric].get(runModel(deal));
  } catch {
    return null;
  }
}

/** Evenly spaced values centred on a base. */
export function axisValues(base, step, count = 5) {
  const half = Math.floor(count / 2);
  return Array.from({ length: count }, (_, i) => base + (i - half) * step);
}

/**
 * Two-variable sensitivity grid.
 * @returns {{xValues, yValues, rows, base, metric}} rows[y][x]
 */
export function sensitivityGrid(deal, {
  xVar = 'exitCapRate',
  yVar = 'interestRate',
  metric = 'leveredIRR',
  xValues = null,
  yValues = null,
  count = 5,
} = {}) {
  const xCfg = VARIABLES[xVar];
  const yCfg = VARIABLES[yVar];
  const xs = xValues || axisValues(xCfg.read(deal), xCfg.step ?? xCfg.read(deal) * 0.05, count);
  const ys = yValues || axisValues(yCfg.read(deal), yCfg.step ?? yCfg.read(deal) * 0.05, count);

  const rows = ys.map((y) =>
    xs.map((x) => evaluate(yCfg.apply(xCfg.apply(deal, x), y), metric)),
  );

  return { xVar, yVar, xValues: xs, yValues: ys, rows, metric, base: evaluate(deal, metric) };
}

/**
 * Tornado: rank variables by their impact on a metric under a symmetric shock.
 *
 * `shocks` are relative for dollar variables and absolute for rate variables,
 * because "exit cap +10%" is not how anyone reasons about a cap rate.
 */
export function tornado(deal, {
  metric = 'leveredIRR',
  variables = ['exitCapRate', 'interestRate', 'constructionCost', 'grossRevenue', 'operatingExpenseRatio', 'vacancyRate'],
  relativeShock = 0.10,
  absoluteShocks = { exitCapRate: 0.5, interestRate: 1.0, vacancyRate: 3, operatingExpenseRatio: 5, downPayment: 10, holdPeriod: 2 },
} = {}) {
  const base = evaluate(deal, metric);
  const bars = variables.map((key) => {
    const cfg = VARIABLES[key];
    const current = cfg.read(deal);
    const delta = absoluteShocks[key] ?? Math.abs(current * relativeShock);
    const low = evaluate(cfg.apply(deal, current - delta), metric);
    const high = evaluate(cfg.apply(deal, current + delta), metric);
    const swing = low !== null && high !== null ? Math.abs(high - low) : 0;
    return { key, label: cfg.label, unit: cfg.unit, base: current, delta, low, high, swing };
  });
  bars.sort((a, b) => b.swing - a.swing);
  return { base, metric, bars };
}

/**
 * Solve for the value of one variable that hits a target metric, by bisection.
 * Returns null when the target is not reachable in the search range — an
 * honest "no answer" beats an extrapolated one.
 */
function bisect(f, lo, fLo, hi, tol, maxIter) {
  let a = lo;
  let b = hi;
  let fa = fLo;
  for (let k = 0; k < maxIter; k++) {
    const mid = (a + b) / 2;
    const fMid = f(mid);
    if (fMid === null) return null;
    if (Math.abs(fMid) < tol || (b - a) / 2 < 1e-12) return mid;
    if (fa * fMid <= 0) { b = mid; } else { a = mid; fa = fMid; }
  }
  return (a + b) / 2;
}

export function breakeven(deal, {
  variable = 'exitCapRate',
  metric = 'leveredIRR',
  target = 0.18,
  lo = null,
  hi = null,
  samples = 48,
  tol = 1e-6,
  maxIter = 80,
} = {}) {
  const cfg = VARIABLES[variable];
  const current = cfg.read(deal);
  if (!Number.isFinite(current) || current === 0) return null;
  const low = lo ?? (cfg.unit === '$' ? current * 0.25 : Math.max(0.01, current * 0.25));
  const high = hi ?? current * 3;

  const f = (v) => {
    const m = evaluate(cfg.apply(deal, v), metric);
    return m === null || !Number.isFinite(m) ? null : m - target;
  };

  // Scan the range for an adjacent pair that brackets a root. A fixed
  // [lo, hi] bracket fails whenever the metric is undefined at an endpoint —
  // IRR has no solution at an extreme cap rate, for instance — and bailing
  // there would report "unreachable" for a target that is plainly reachable
  // in the middle of the range.
  const step = (high - low) / samples;
  let a = null;
  let fa = null;
  for (let i = 0; i <= samples; i++) {
    const x = low + i * step;
    const fx = f(x);
    if (fx === null) { a = null; fa = null; continue; }
    if (Math.abs(fx) < tol) return x;
    if (a !== null && fa * fx < 0) {
      const root = bisect(f, a, fa, x, tol, maxIter);
      // A sign change is not proof of a root. These metrics are discontinuous:
      // past some exit cap the equity flows stop changing sign, IRR becomes
      // undefined, and on the far side it reappears as a large negative. A
      // scan can straddle that jump, and bisection then converges to the
      // discontinuity rather than to a solution. Verify before returning —
      // a confidently wrong breakeven is worse than no answer.
      if (root !== null) {
        const check = f(root);
        if (check !== null && Math.abs(check) < Math.max(tol, Math.abs(target) * 1e-4)) return root;
      }
      // False root: keep scanning past the discontinuity.
    }
    a = x;
    fa = fx;
  }
  return null;
}

/** Named scenarios as deltas off the base deal. */
export const DEFAULT_SCENARIOS = [
  { key: 'downside', label: 'Downside', deltas: { exitCapRate: +0.75, interestRate: +1.0, constructionCostPct: +0.10, grossRevenuePct: -0.08 } },
  { key: 'base',     label: 'Base',     deltas: {} },
  { key: 'upside',   label: 'Upside',   deltas: { exitCapRate: -0.40, grossRevenuePct: +0.06 } },
];

export function applyScenario(deal, deltas = {}) {
  let d = { ...deal };
  if (deltas.exitCapRate) d.exitCapRate = d.exitCapRate + deltas.exitCapRate;
  if (deltas.interestRate) d.interestRate = d.interestRate + deltas.interestRate;
  if (deltas.constructionCostPct) d.constructionCost = d.constructionCost * (1 + deltas.constructionCostPct);
  if (deltas.grossRevenuePct) d.grossRevenue = d.grossRevenue * (1 + deltas.grossRevenuePct);
  if (deltas.vacancyRate) d.vacancyRate = d.vacancyRate + deltas.vacancyRate;
  return d;
}

export function runScenarios(deal, scenarios = DEFAULT_SCENARIOS) {
  return scenarios.map((s) => {
    const scenarioDeal = applyScenario(deal, s.deltas);
    return { ...s, deal: scenarioDeal, model: runModel(scenarioDeal) };
  });
}
