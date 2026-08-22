import { SAMPLE_DEALS } from '../sampleDeals';
import { runModel, calculateMetrics } from '../finance';

describe('sample deals', () => {
  it('all have unique ids and a resolvable market', () => {
    const ids = SAMPLE_DEALS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of SAMPLE_DEALS) expect(d.location).toMatch(/, (TX|FL)$/);
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
