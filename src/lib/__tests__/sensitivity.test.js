import { runModel, calculateMetrics } from '../finance';
import { validate, flagCounts, DEFAULT_COVENANTS } from '../validation';
import {
  VARIABLES, METRICS, axisValues, sensitivityGrid, tornado, breakeven,
  applyScenario, runScenarios, DEFAULT_SCENARIOS,
} from '../sensitivity';
import { SAMPLE_DEALS } from '../sampleDeals';

const base = SAMPLE_DEALS[0];

describe('validation', () => {
  it('passes a healthy deal with no errors', () => {
    const flags = validate(runModel(base), base);
    expect(flags.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('flags a DSCR covenant breach against the rate field', () => {
    const levered = { ...base, downPayment: 8, interestRate: 12 };
    const flags = validate(runModel(levered), levered);
    const dscr = flags.find((f) => f.id === 'dscr');
    expect(dscr).toBeDefined();
    expect(dscr.severity).toBe('error');
    expect(dscr.field).toBe('interestRate');
  });

  it('escalates a negative development spread to an error', () => {
    const bad = { ...base, exitCapRate: 14 };
    const spread = validate(runModel(bad), bad).find((f) => f.id === 'spread');
    expect(spread.severity).toBe('error');
    expect(spread.detail).toMatch(/does not pencil/i);
  });

  it('flags leverage above the credit box', () => {
    const geared = { ...base, downPayment: 10 };
    expect(validate(runModel(geared), geared).find((f) => f.id === 'ltc')).toBeDefined();
  });

  it('flags cap rate compression when the exit is tighter than entry', () => {
    const deal = { ...base, entryCapRate: 7.5, exitCapRate: 6.0 };
    expect(validate(runModel(deal), deal).find((f) => f.id === 'capCompression')).toBeDefined();
  });

  it('flags negative leverage', () => {
    const deal = { ...base, interestRate: 15, downPayment: 40 };
    const flags = validate(runModel(deal), deal);
    expect(flags.find((f) => f.id === 'negativeLeverage')).toBeDefined();
  });

  it('honours firm-specific covenants over the defaults', () => {
    const strict = validate(runModel(base), base, { minDevSpreadBps: 100000 });
    expect(strict.find((f) => f.id === 'spread')).toBeDefined();
    expect(DEFAULT_COVENANTS.minDevSpreadBps).toBe(100);
  });

  it('orders errors before warnings before info', () => {
    const messy = { ...base, downPayment: 8, interestRate: 13, exitCapRate: 13 };
    const sev = validate(runModel(messy), messy).map((f) => f.severity);
    const rank = { error: 0, warning: 1, info: 2 };
    expect(sev.map((s) => rank[s])).toEqual([...sev.map((s) => rank[s])].sort((a, b) => a - b));
  });

  it('returns a single incomplete flag for an unmodellable deal', () => {
    const flags = validate(runModel({}), {});
    expect(flags).toHaveLength(1);
    expect(flags[0].id).toBe('incomplete');
  });

  it('counts flags by severity', () => {
    expect(flagCounts([{ severity: 'error' }, { severity: 'error' }, { severity: 'info' }]))
      .toEqual({ error: 2, warning: 0, info: 1 });
  });
});

describe('axisValues', () => {
  it('centres the axis on the base value', () => {
    expect(axisValues(7.0, 0.25, 5)).toEqual([6.5, 6.75, 7.0, 7.25, 7.5]);
  });
});

describe('sensitivityGrid', () => {
  const grid = sensitivityGrid(base, { xVar: 'exitCapRate', yVar: 'interestRate', metric: 'leveredIRR' });

  it('returns a rows[y][x] matrix matching the axes', () => {
    expect(grid.yValues).toHaveLength(5);
    expect(grid.rows).toHaveLength(5);
    for (const row of grid.rows) expect(row).toHaveLength(grid.xValues.length);
  });

  it('reproduces the base case at the centre cell', () => {
    expect(grid.rows[2][2]).toBeCloseTo(grid.base, 9);
  });

  it('falls monotonically as the exit cap widens', () => {
    const row = grid.rows[2];
    for (let i = 1; i < row.length; i++) expect(row[i]).toBeLessThan(row[i - 1]);
  });

  it('falls monotonically as the interest rate rises', () => {
    const col = grid.rows.map((r) => r[2]);
    for (let i = 1; i < col.length; i++) expect(col[i]).toBeLessThan(col[i - 1]);
  });

  it('agrees with a direct model run at an off-centre cell', () => {
    const direct = runModel({ ...base, exitCapRate: grid.xValues[0], interestRate: grid.yValues[0] });
    expect(grid.rows[0][0]).toBeCloseTo(direct.returns.leveredIRR, 12);
  });

  it('supports every declared metric', () => {
    for (const metric of Object.keys(METRICS)) {
      const g = sensitivityGrid(base, { metric, count: 3 });
      expect(g.rows.flat().every((v) => v === null || Number.isFinite(v))).toBe(true);
    }
  });
});

describe('tornado', () => {
  const t = tornado(base, { metric: 'leveredIRR' });

  it('ranks variables by swing, widest first', () => {
    const swings = t.bars.map((b) => b.swing);
    expect(swings).toEqual([...swings].sort((a, b) => b - a));
  });

  it('covers each requested variable once', () => {
    expect(new Set(t.bars.map((b) => b.key)).size).toBe(t.bars.length);
    for (const b of t.bars) expect(VARIABLES).toHaveProperty(b.key);
  });

  it('uses absolute shocks for rates, not percentage-of-rate', () => {
    const cap = t.bars.find((b) => b.key === 'exitCapRate');
    expect(cap.delta).toBe(0.5);
  });

  it('produces a non-zero swing for the dominant driver', () => {
    expect(t.bars[0].swing).toBeGreaterThan(0);
  });
});

describe('breakeven', () => {
  it('solves the exit cap that hits a target IRR', () => {
    const target = 0.15;
    const solved = breakeven(base, { variable: 'exitCapRate', metric: 'leveredIRR', target });
    expect(solved).not.toBeNull();
    const check = runModel({ ...base, exitCapRate: solved }).returns.leveredIRR;
    expect(check).toBeCloseTo(target, 4);
  });

  it('solves the revenue that hits a DSCR covenant', () => {
    const solved = breakeven(base, { variable: 'grossRevenue', metric: 'minDSCR', target: 1.25 });
    expect(solved).not.toBeNull();
    expect(runModel({ ...base, grossRevenue: solved }).operating.minDSCR).toBeCloseTo(1.25, 4);
  });

  it('returns null when the target is unreachable rather than extrapolating', () => {
    expect(breakeven(base, { variable: 'vacancyRate', metric: 'leveredIRR', target: 5.0 })).toBeNull();
  });

  it('rejects a false root produced by a discontinuity in the metric', () => {
    // IRR is discontinuous in exit cap: past some cap the equity flows stop
    // changing sign, IRR goes undefined, and beyond that it returns as a large
    // negative. A naive sign-change scan straddles that jump and "solves" to
    // the discontinuity. Any value returned must actually hit the target.
    const solved = breakeven(base, { variable: 'exitCapRate', metric: 'leveredIRR', target: 50 });
    if (solved !== null) {
      expect(runModel({ ...base, exitCapRate: solved }).returns.leveredIRR).toBeCloseTo(50, 2);
    }
  });
});

describe('scenarios', () => {
  it('applies rate deltas absolutely and dollar deltas proportionally', () => {
    const d = applyScenario(base, { exitCapRate: +0.75, grossRevenuePct: -0.10 });
    expect(d.exitCapRate).toBeCloseTo(base.exitCapRate + 0.75, 9);
    expect(d.grossRevenue).toBeCloseTo(base.grossRevenue * 0.9, 6);
  });

  it('leaves the base scenario untouched', () => {
    const results = runScenarios(base);
    const baseCase = results.find((r) => r.key === 'base');
    expect(baseCase.model.returns.leveredIRR).toBeCloseTo(runModel(base).returns.leveredIRR, 12);
  });

  it('orders downside below base below upside on IRR', () => {
    const [down, mid, up] = runScenarios(base).map((r) => r.model.returns.leveredIRR);
    expect(down).toBeLessThan(mid);
    expect(mid).toBeLessThan(up);
  });

  it('never mutates the input deal', () => {
    const snapshot = JSON.stringify(base);
    runScenarios(base);
    sensitivityGrid(base, {});
    tornado(base, {});
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('exposes three default scenarios', () => {
    expect(DEFAULT_SCENARIOS.map((s) => s.key)).toEqual(['downside', 'base', 'upside']);
  });
});

describe('DSCR metric consistency', () => {
  it('exposes stabilized DSCR as its own metric, distinct from lease-up-inclusive', () => {
    expect(METRICS.minStabilizedDSCR).toBeDefined();
    const m = runModel(base);
    expect(METRICS.minStabilizedDSCR.get(m)).toBe(m.operating.minStabilizedDSCR);
    expect(METRICS.minDSCR.get(m)).toBe(m.operating.minDSCR);
    // These differ materially: coverage during lease-up is far below the
    // stabilized figure a covenant is tested against.
    expect(m.operating.minDSCR).toBeLessThan(m.operating.minStabilizedDSCR);
  });

  it('solves the rate that pushes stabilized DSCR to its covenant', () => {
    const solved = breakeven(base, { variable: 'interestRate', metric: 'minStabilizedDSCR', target: 1.25 });
    expect(solved).not.toBeNull();
    // Raising the rate must be what breaches the covenant, not lowering it.
    expect(solved).toBeGreaterThan(base.interestRate);
    expect(runModel({ ...base, interestRate: solved }).operating.minStabilizedDSCR).toBeCloseTo(1.25, 4);
  });
});

describe('operating metrics in the sensitivity surface', () => {
  const acquisition = SAMPLE_DEALS[7];   // Alamo Ridge: in-place income at close

  it('exposes break-even occupancy and going-in cap rate as flexable metrics', () => {
    expect(METRICS.breakEvenOccupancy).toBeDefined();
    expect(METRICS.goingInCapRate).toBeDefined();
    const m = runModel(acquisition);
    expect(METRICS.breakEvenOccupancy.get(m)).toBe(m.operating.breakEvenOccupancy);
    expect(METRICS.goingInCapRate.get(m)).toBe(m.operating.goingInCapRate);
  });

  it('tags both as ratios, so a formatter scaling by 100 renders them correctly', () => {
    // The named failure mode: a ratio carried under a tag that does not scale
    // renders an 88% break-even occupancy as "0.88%" — a building that appears
    // to cover its costs on almost no tenants at all. Yield on cost is the
    // known-good ratio metric on this surface; these must share its tag.
    expect(METRICS.breakEvenOccupancy.format).toBe(METRICS.yieldOnCost.format);
    expect(METRICS.goingInCapRate.format).toBe(METRICS.yieldOnCost.format);

    const m = runModel(acquisition);
    for (const key of ['breakEvenOccupancy', 'goingInCapRate', 'yieldOnCost']) {
      const v = METRICS[key].get(m);
      expect(v).toBeGreaterThan(0);
      // A ratio, never the percent-scaled twin: 0.88 and 0.051, not 88 and 5.1.
      expect(v).toBeLessThan(1);
    }
  });

  it('reads the going-in cap rate off the model, not off the percent-scaled metric bag', () => {
    // calculateMetrics() percent-scales this figure for the flat bag the UI
    // reads. Binding the sensitivity surface to that copy would flex a metric
    // a hundred times its true size through a formatter that scales again.
    const m = runModel(acquisition);
    expect(METRICS.goingInCapRate.get(m) * 100)
      .toBeCloseTo(calculateMetrics(acquisition).goingInCapRate, 9);
  });

  it('reports no going-in cap rate for a ground-up deal rather than borrowing yield on cost', () => {
    const m = runModel(base);
    expect(METRICS.goingInCapRate.get(m)).toBeNull();
    expect(METRICS.yieldOnCost.get(m)).not.toBeNull();
  });

  it('flexes break-even occupancy in the grid: dearer debt raises it', () => {
    // Debt service is in the numerator, so a higher rate leaves less room
    // before the asset stops paying its own bills.
    const grid = sensitivityGrid(base, {
      xVar: 'exitCapRate', yVar: 'interestRate', metric: 'breakEvenOccupancy',
    });
    const col = grid.rows.map((r) => r[2]);
    for (let i = 1; i < col.length; i++) expect(col[i]).toBeGreaterThan(col[i - 1]);
    // The exit cap does not price the operating year, so the row is flat.
    for (const v of grid.rows[2]) expect(v).toBeCloseTo(grid.base, 12);
  });

  it('flexes break-even occupancy against the operating cost it is built from', () => {
    const t = tornado(base, { metric: 'breakEvenOccupancy', variables: ['operatingExpenseRatio', 'interestRate'] });
    for (const bar of t.bars) expect(bar.swing).toBeGreaterThan(0);
    expect(t.base).toBeCloseTo(runModel(base).operating.breakEvenOccupancy, 12);
  });

  it('flexes the going-in cap rate against the price paid for the income', () => {
    // The basis is the purchase price, so the same in-place NOI over a bigger
    // cheque is a lower going-in yield.
    const dearer = runModel({ ...acquisition, purchasePrice: acquisition.purchasePrice * 1.2 });
    expect(METRICS.goingInCapRate.get(dearer))
      .toBeLessThan(METRICS.goingInCapRate.get(runModel(acquisition)));
  });
});

describe('metric polarity', () => {
  it('declares a direction for every metric', () => {
    // The tornado exhibit paints the below-base side one colour and the
    // above-base side the other, and until break-even occupancy arrived every
    // metric here was higher-is-better, so that direction was hard-coded into
    // the renderer. A metric with no declared polarity silently inherits it.
    for (const [key, m] of Object.entries(METRICS)) {
      expect([1, -1]).toContain(m.polarity);
      expect(typeof key).toBe('string');
    }
  });

  it('marks break-even occupancy as higher-is-worse', () => {
    // The named failure: a revenue CUT raises break-even occupancy, eroding the
    // cushion over underwritten occupancy, and the exhibit drew that bar green.
    expect(METRICS.breakEvenOccupancy.polarity).toBe(-1);
    expect(METRICS.leveredIRR.polarity).toBe(1);
    expect(METRICS.minStabilizedDSCR.polarity).toBe(1);
  });

  it('moves break-even occupancy the opposite way to levered IRR on the same lever', () => {
    // The invariant behind the polarity flag, measured rather than asserted.
    const deal = SAMPLE_DEALS[5];
    const be = tornado(deal, { metric: 'breakEvenOccupancy' });
    const irrTor = tornado(deal, { metric: 'leveredIRR' });
    const bar = (t) => t.bars.find((b) => b.key === 'grossRevenue');
    const beBar = bar(be);
    const irrBar = bar(irrTor);
    expect(beBar).toBeDefined();
    expect(irrBar).toBeDefined();
    // More revenue: a lower break-even and a higher IRR.
    expect(Math.sign(beBar.high - beBar.low)).toBe(-Math.sign(irrBar.high - irrBar.low));
  });
});
