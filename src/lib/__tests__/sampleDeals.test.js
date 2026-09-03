import { SAMPLE_DEALS, DEAL_STAGES } from '../sampleDeals';
import { findMarket } from '../markets';
import { runModel, calculateMetrics } from '../finance';
import { validate } from '../validation';
import { constructionTypes } from '../propertyTypes';

describe('sample deals', () => {
  it('all have unique ids and a resolvable market', () => {
    const ids = SAMPLE_DEALS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of SAMPLE_DEALS) {
      expect(d.location).toMatch(/, (TX|FL)$/);
      expect(findMarket(d.location)).not.toBeNull();
    }
  });

  it('all carry the pipeline fields the ledger renders', () => {
    for (const d of SAMPLE_DEALS) {
      expect(DEAL_STAGES).toContain(d.stage);
      expect(typeof d.owner).toBe('string');
      expect(typeof d.program).toBe('string');
    }
  });

  it.each(SAMPLE_DEALS.map((d) => [d.name, d]))(
    '%s produces a complete, finite model', (_name, deal) => {
      const r = runModel(deal);
      expect(r.incomplete).toBeUndefined();
      expect(Number.isFinite(r.operating.stabilizedNOI)).toBe(true);
      expect(Number.isFinite(r.budget.totalProjectCost)).toBe(true);
      expect(r.returns.leveredIRR).not.toBeNull();
    },
  );

  it.each(SAMPLE_DEALS.map((d) => [d.name, d]))(
    '%s stays inside a defensible return range', (_name, deal) => {
      const r = runModel(deal);
      // Guard against the class of error the original samples shipped with:
      // a 15.6% yield on cost, an 841 bps development spread and a 7.15x
      // equity multiple, none of which are achievable outcomes.
      expect(r.operating.yieldOnCost).toBeGreaterThan(0.03);
      expect(r.operating.yieldOnCost).toBeLessThan(0.13);
      expect(r.operating.developmentSpreadBps).toBeLessThan(400);
      expect(r.returns.equityMultiple).toBeLessThan(4);
      expect(r.returns.leveredIRR).toBeLessThan(0.45);
    },
  );

  it('includes at least one deal that does not comfortably pencil', () => {
    // A tool that only ever shows winners is not an underwriting tool.
    const spreads = SAMPLE_DEALS.map((d) => runModel(d).operating.developmentSpreadBps);
    expect(Math.min(...spreads)).toBeLessThan(150);
  });

  it('includes at least one deal a credit committee should refuse', () => {
    // Stronger than a thin spread: something in the portfolio must actually
    // trip an ERROR-severity covenant flag, so a first-time user sees the
    // screen fire rather than learning it never does. Austin is the deal
    // carrying that job — a negative development spread and a coverage breach.
    const failing = SAMPLE_DEALS.filter((d) =>
      validate(runModel(d), d).some((f) => f.severity === 'error'));
    expect(failing.length).toBeGreaterThan(0);
  });

  it('prices every repositioning deal on one definition of in-place NOI', () => {
    // The renovation schedule and the going-in cap rate describe the same
    // income on the same basis and land in the same exported row. They were
    // 312 bps apart on Alamo Ridge, and a portfolio tuned against the richer of
    // the two is a portfolio tuned against a number the engine no longer
    // reports. Sample economics are only defensible if they are struck on the
    // figure the schedule actually charges.
    // No `goingInNOI === null` skip: that gated the loop on the going-in CAP
    // RATE, and the one deal in the portfolio bought empty — Dallas Office TI,
    // the deal this policy moves hardest — has no cap rate, so the check ran
    // only on the three deals where a divergence was never in doubt.
    let repositioning = 0;
    for (const d of SAMPLE_DEALS) {
      const r = runModel(d);
      if (!constructionTypes[d.constructionType].hasInPlaceIncome) continue;
      repositioning++;
      expect(r.months[0].phase).toBe('construction');
      expect(r.operating.goingInNOI).not.toBeNull();
      expect(r.months[0].noi * 12).toBeCloseTo(r.operating.goingInNOI, 6);
    }
    expect(repositioning).toBe(4);
  });

  it('exposes every column the CSV export reads', () => {
    const keys = [
      'totalProjectCost', 'capitalizedInterest', 'downPaymentAmount', 'peakEquity',
      'noi', 'yieldOnCost', 'developmentSpreadBps', 'dscr', 'minDSCR', 'debtYield',
      'exitValue', 'netSaleProceeds', 'leveredIRR', 'unleveredIRR', 'equityMultiple',
      'profit', 'constructionTimeframe',
    ];
    for (const deal of SAMPLE_DEALS) {
      const m = calculateMetrics(deal);
      for (const k of keys) expect(m).toHaveProperty(k);
    }
  });
});
