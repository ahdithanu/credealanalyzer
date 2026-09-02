import { buildMemo, screeningVerdict, fieldLabel, SECTIONS } from '../memo';
import { NA } from '../format';
import { runModel } from '../finance';
import { SAMPLE_DEALS } from '../sampleDeals';

const healthy = SAMPLE_DEALS[0];          // Houston
const thin = SAMPLE_DEALS[1];             // Austin, negative development spread

describe('screeningVerdict', () => {
  it('reports a clean pass against the firm thresholds', () => {
    // Two points more equity than the shipped sample carries. At 30% down the
    // deal funds 70.9% of total project cost once the interest reserve is
    // counted as the borrowed money it is, and fails loan-to-cost.
    const v = screeningVerdict(runModel({ ...healthy, downPayment: 32 }));
    expect(v.failedCount).toBe(0);
    expect(v.verdict).toMatch(/meets all/i);
    expect(v.tests).toHaveLength(4);
  });

  it('names the failing criteria', () => {
    const v = screeningVerdict(runModel(thin));
    expect(v.failedCount).toBeGreaterThan(0);
    expect(v.summary.toLowerCase()).toContain('development spread');
  });

  it('frames itself as a screen, never a recommendation', () => {
    // The document leaves the building; it must not read as investment advice.
    for (const deal of [healthy, thin]) {
      expect(screeningVerdict(runModel(deal)).summary).toMatch(/not a recommendation/i);
    }
  });

  it('treats loan-to-cost as an upper bound, not a floor', () => {
    const geared = screeningVerdict(runModel({ ...healthy, downPayment: 10 }));
    const ltc = geared.tests.find((t) => t.label === 'Loan to cost');
    expect(ltc.inverted).toBe(true);
    expect(ltc.pass).toBe(false);
  });

  it('refuses to screen an unmodellable deal', () => {
    const v = screeningVerdict(runModel({}));
    expect(v.verdict).toBe('Incomplete');
    expect(v.tests).toEqual([]);
  });
});

describe('buildMemo', () => {
  const memo = buildMemo(healthy, { preparedBy: 'Rivera', date: new Date('2026-08-30') });

  it('produces the six wireframed sections in order', () => {
    expect(memo.pages).toHaveLength(6);
    expect(memo.pages.map((p) => p.title)).toEqual(SECTIONS);
    expect(memo.pages.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('carries the deal identity and preparer in its header', () => {
    expect(memo.meta.dealName).toBe(healthy.name);
    expect(memo.meta.preparedBy).toBe('Rivera');
    expect(memo.meta.confidential).toBe(true);
    expect(memo.meta.pageCount).toBe(6);
  });

  it('binds every block to a named source so a figure can be traced', () => {
    const bound = memo.pages.flatMap((p) => p.blocks)
      .filter((b) => b.type === 'table' || b.type === 'matrix');
    expect(bound.length).toBeGreaterThan(0);
    for (const b of bound) expect(typeof b.source).toBe('string');
  });

  it('reports how many figures it computed', () => {
    expect(memo.provenance.modelFigureCount).toBeGreaterThan(60);
  });

  it('never emits a raw NaN, undefined or [object Object] into the document', () => {
    const text = JSON.stringify(memo);
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/undefined/);
    expect(text).not.toMatch(/\[object Object\]/);
  });

  it('reconciles the sources & uses table to total development cost', () => {
    const model = runModel(healthy);
    const su = memo.pages[0].blocks.find((b) => b.title === 'Sources & uses');
    expect(su.rows).toHaveLength(model.budget.lines.length);
    expect(su.total[1]).toBe(Math.round(model.budget.totalProjectCost / 1000).toLocaleString('en-US'));
  });

  it('quotes the same levered IRR the model produces', () => {
    const model = runModel(healthy);
    const headline = memo.pages[0].blocks.find((b) => b.type === 'headline');
    const irr = headline.items.find((i) => i.label === 'Levered IRR');
    expect(irr.value).toBe(`${(model.returns.leveredIRR * 100).toFixed(1)}%`);
  });

  it('prices the exit off forward NOI and nets the loan payoff', () => {
    const exitTable = memo.pages[1].blocks.find((b) => b.title === 'Exit');
    expect(exitTable.rows.map((r) => r[0])).toEqual(
      expect.arrayContaining(['Forward 12-month NOI', 'Gross sale price', 'Cost of sale', 'Loan payoff']),
    );
    expect(exitTable.total[0]).toBe('Net sale proceeds');
  });

  it('reports both DSCR measures so lease-up coverage is not hidden', () => {
    const t = memo.pages[1].blocks.find((b) => b.title === 'Operating & credit');
    const labels = t.rows.map((r) => r[0]);
    expect(labels).toContain('DSCR, stabilized');
    expect(labels).toContain('DSCR, incl. lease-up');
  });

  it('includes one cash flow row per modelled year and marks the stub', () => {
    const model = runModel(healthy);
    const cf = memo.pages[2].blocks.find((b) => b.type === 'table');
    expect(cf.rows).toHaveLength(model.annual.length);
    expect(cf.rows[cf.rows.length - 1][0]).toMatch(/mo\)$/);
  });

  it('states that departures from the firm assumption set are none when there are none', () => {
    // Every governed field set to its firm default for this property type.
    const clean = buildMemo({
      ...healthy,
      interestRate: 6.40, loanTerm: 25, downPayment: 30,
      vacancyRate: 3, operatingExpenseRatio: 44, exitCapRate: 7.25,
    });
    const note = clean.pages[5].blocks.find((b) => b.title === 'Departures from the firm assumption set');
    expect(note.text).toMatch(/^None\./);
  });

  it('lists each departure when assumptions are overridden', () => {
    const note = memo.pages[5].blocks.find((b) => b.title === 'Departures from the firm assumption set');
    expect(note.text).toMatch(/underwritten at/);
  });

  it('carries the seed-data limitation in the document, not just the UI', () => {
    const disclosure = memo.pages[5].blocks.find((b) => b.type === 'disclosure');
    const joined = disclosure.items.join(' ');
    expect(joined).toMatch(/seed values/i);
    expect(joined).toMatch(/must not be relied upon/i);
    expect(joined).toMatch(/not an investment recommendation/i);
  });

  it('discloses what the model does not do', () => {
    const joined = memo.pages[5].blocks.find((b) => b.type === 'disclosure').items.join(' ');
    expect(joined).toMatch(/no rent roll/i);
    expect(joined).toMatch(/waterfall|promote/i);
  });

  it('surfaces validation flags rather than suppressing them', () => {
    const flagged = buildMemo(thin);
    const block = flagged.pages[5].blocks.find((b) => b.type === 'flags');
    expect(block.flags.length).toBeGreaterThan(0);
    expect(block.flags.some((f) => f.severity === 'error' || f.severity === 'warning')).toBe(true);
  });

  it('degrades to an explanatory note when the market cannot be resolved', () => {
    const offMap = buildMemo({ ...healthy, location: 'Boise, ID' });
    const page = offMap.pages[4];
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0].type).toBe('note');
    expect(page.blocks[0].text).toMatch(/not in the reference set/i);
    expect(offMap.provenance.marketDataQuality).toBe('unresolved');
  });

  it('records the market data quality it was built on', () => {
    expect(memo.provenance.marketDataQuality).toBe('seed');
  });

  it('builds for every sample deal without throwing', () => {
    for (const deal of SAMPLE_DEALS) {
      const m = buildMemo(deal);
      expect(m.pages).toHaveLength(6);
      expect(JSON.stringify(m)).not.toMatch(/NaN|undefined/);
    }
  });
});

describe('appendix presentation', () => {
  const memo = buildMemo(healthy);
  const table = memo.pages[5].blocks.find((b) => b.type === 'table');

  it('expresses the underwritten value and the firm default in the same units', () => {
    // Regression: the appendix read "3.0%" against a bare "3".
    for (const [label, underwritten, firmValue] of table.rows) {
      if (firmValue === '—' || firmValue === NA || /Resolved|property type/i.test(firmValue)) continue;
      const unit = (s) => (s.endsWith('%') ? '%' : s.endsWith('yrs') ? 'yrs' : s.startsWith('$') ? '$' : '?');
      expect(`${label}:${unit(firmValue)}`).toBe(`${label}:${unit(underwritten)}`);
    }
  });

  it('names departures in prose rather than dumping field keys', () => {
    const note = memo.pages[5].blocks.find((b) => b.title === 'Departures from the firm assumption set');
    expect(note.text).toContain('All-in rate');
    expect(note.text).not.toMatch(/interestRate|operatingExpenseRatio|exitCapRate/);
    expect(note.text).toMatch(/is underwritten at .* against a firm default of /);
  });

  it('labels every governed field', () => {
    expect(fieldLabel('interestRate')).toBe('All-in rate');
    expect(fieldLabel('somethingUngoverned')).toBe('somethingUngoverned');
  });
});
