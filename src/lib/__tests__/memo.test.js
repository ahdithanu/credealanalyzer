import { buildMemo, screeningVerdict, fieldLabel, SECTIONS } from '../memo';
import { NA } from '../format';
import { runModel } from '../finance';
import { waterfallFromModel } from '../waterfall';
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

describe('operating & credit page', () => {
  const houston = buildMemo(healthy);                  // ground-up, no in-place income
  const alamo = buildMemo(SAMPLE_DEALS[7]);            // acquisition with in-place income
  const table = (memo) => memo.pages[1].blocks.find((b) => b.title === 'Operating & credit');
  const row = (memo, label) => table(memo).rows.find((r) => r[0] === label);

  it('reports break-even occupancy and going-in cap rate, each with its basis', () => {
    for (const memo of [houston, alamo]) {
      for (const label of ['Break-even occupancy', 'Going-in cap rate']) {
        const r = row(memo, label);
        expect(r).toBeDefined();
        // The Test column is what makes the figure auditable; a bare number
        // in an IC memo is a number the committee has to take on trust.
        expect(typeof r[2]).toBe('string');
        expect(r[2].length).toBeGreaterThan(10);
      }
    }
  });

  it('renders break-even occupancy as a share of the rent roll, not a bare ratio', () => {
    // model.operating carries 0.826. Rendered through a formatter that does not
    // scale, an 82.6% break-even prints as "0.83%" — a deal that looks as
    // though it breaks even on almost no occupancy at all.
    const be = runModel(healthy).operating.breakEvenOccupancy;
    expect(be).toBeGreaterThan(0.5);
    expect(row(houston, 'Break-even occupancy')[1]).toBe(`${(be * 100).toFixed(1)}%`);
  });

  it('scales the going-in cap rate exactly once', () => {
    // The flat metric bag percent-scales its own copy of this figure. Binding
    // the memo to that one and scaling again prints 508%.
    const ratio = runModel(SAMPLE_DEALS[7]).operating.goingInCapRate;
    expect(ratio).toBeLessThan(1);
    expect(row(alamo, 'Going-in cap rate')[1]).toBe(`${(ratio * 100).toFixed(2)}%`);
  });

  it('reports no going-in cap rate for a ground-up deal and says why', () => {
    // The failure mode is borrowing yield on cost for the cell: a ground-up
    // deal has no income in place, so the number does not exist.
    expect(runModel(healthy).operating.goingInCapRate).toBeNull();
    const r = row(houston, 'Going-in cap rate');
    expect(r[1]).toBe(NA);
    expect(r[1]).not.toBe(row(houston, 'Yield on cost')[1]);
    expect(r[2]).toMatch(/no going-in yield|no income in place/i);
  });

  it('names the right reason when a deal that HAS in-place income has no going-in cap', () => {
    // The null branch asserted a fact about the deal that is false for two of
    // the three ways the rate can be missing: it called every one of them
    // ground-up. A tenant-improvement deal has in-place income by type, and an
    // acquisition with $3.4m of in-place revenue and a blank purchase price is
    // missing a BASIS, not income.
    const ti = SAMPLE_DEALS.find((d) => d.constructionType === 'ti');
    expect(runModel(ti).operating.goingInCapRate).toBeNull();
    expect(row(buildMemo(ti), 'Going-in cap rate')[2]).not.toMatch(/ground-up/i);

    const noBasis = { ...SAMPLE_DEALS[6], purchasePrice: 0 };
    const m = runModel(noBasis);
    expect(m.operating.acquisitionBasis).toBeNull();
    expect(m.assumptions.inPlaceRevenue).toBeGreaterThan(0);
    const basisReason = row(buildMemo(noBasis), 'Going-in cap rate')[2];
    expect(basisReason).not.toMatch(/ground-up/i);
    expect(basisReason).toMatch(/basis/i);
  });

  it('labels the occupancy cushion on the occupancy the engine actually reports', () => {
    // model.operating.stabilizedOccupancy is the MEAN occupancy across the
    // twelve-month stabilisation window, which finance.js records can still be
    // leasing up on a short hold — not the vacancy assumption. Labelled as the
    // underwritten input, the memo printed -4,390 bps under a caption whose own
    // arithmetic gives +993: a 5,383 bps gap and the opposite sign.
    const shortHold = { ...SAMPLE_DEALS[1], holdPeriod: 1 };
    const m = runModel(shortHold);
    const underwritten = 1 - shortHold.vacancyRate / 100;
    expect(m.operating.stabilizedOccupancy).toBeLessThan(underwritten - 0.05);

    const memo = buildMemo(shortHold);
    const cushion = row(memo, 'Occupancy cushion');
    expect(cushion[2]).not.toMatch(/underwritten/i);
    // The basis it names is on the page beside it, so the arithmetic is checkable.
    const avg = row(memo, 'Average stabilised-year occupancy');
    expect(avg[1]).toBe(`${(m.operating.stabilizedOccupancy * 100).toFixed(1)}%`);
  });

  it('states going-in cap rate and yield on cost as separate measures', () => {
    const labels = table(alamo).rows.map((r) => r[0]);
    expect(labels).toContain('Yield on cost');
    expect(labels).toContain('Going-in cap rate');
    expect(row(alamo, 'Going-in cap rate')[1]).not.toBe(row(alamo, 'Yield on cost')[1]);
  });
});

describe('debt sizing disclosure', () => {
  const note = (memo) => memo.pages[1].blocks.find((b) => b.title === 'Debt sizing');

  it('says the loan is the residual of the equity input when it is', () => {
    const text = note(buildMemo(healthy)).text;
    expect(text).toMatch(/residual of the underwritten equity share/i);
    expect(text).not.toMatch(/binds at/i);
  });

  it('names the binding constraint when the loan was sized to one', () => {
    // A loan sized to a covenant and a loan sized to an equity percentage are
    // different claims about the same dollar figure, and the capital stack
    // table reads identically either way.
    const deal = { ...healthy, sizeDebtToConstraints: true };
    expect(runModel(deal).financing.sizing.bindingConstraint).toBe('ltc');
    const text = note(buildMemo(deal)).text;
    expect(text).toMatch(/sized to the binding lender constraint/i);
    expect(text).toMatch(/loan to cost binds at/i);
    // The tests that did not bind still have to appear, or a reader cannot
    // tell how much headroom the deal had.
    expect(text).toMatch(/debt service coverage/i);
    expect(text).toMatch(/debt yield/i);
  });

  it('names coverage rather than leverage when coverage is what binds', () => {
    const deal = { ...healthy, sizeDebtToConstraints: true, interestRate: 13 };
    expect(runModel(deal).financing.sizing.bindingConstraint).toBe('dscr');
    expect(note(buildMemo(deal)).text).toMatch(/debt service coverage binds at/i);
  });

  it('never prints an unevaluated constraint as a dollar amount', () => {
    const deal = { ...healthy, sizeDebtToConstraints: true, debtSizing: { minDSCR: 0, minDebtYield: 0 } };
    const sizing = runModel(deal).financing.sizing;
    expect(sizing.constraints.dscr).toBeNull();
    const text = note(buildMemo(deal)).text;
    expect(text).toMatch(/debt service coverage not evaluated/i);
    expect(text).not.toMatch(/debt service coverage \$0/i);
  });
});

describe('waterfall on the returns page', () => {
  const structure = {
    prefRate: 0.08,
    catchUp: { enabled: true, gpShare: 1.0, targetPromoteShare: null },
    tiers: [{ irrHurdle: 0.15, gpShare: 0.20 }, { irrHurdle: null, gpShare: 0.30 }],
  };
  const promoted = buildMemo(healthy, { waterfall: structure });
  const plain = buildMemo(healthy);
  const wfTable = promoted.pages[1].blocks.find((b) => b.title === 'Distribution waterfall');
  const value = (label) => wfTable.rows.find((r) => r[0] === label)[1];

  it('omits the waterfall entirely when no structure is configured', () => {
    expect(plain.pages[1].blocks.find((b) => b.title === 'Distribution waterfall')).toBeUndefined();
  });

  it('reads a structure carried on the deal as well as one passed in', () => {
    const onDeal = buildMemo({ ...healthy, waterfall: structure });
    expect(onDeal.pages[1].blocks.find((b) => b.title === 'Distribution waterfall')).toBeDefined();
  });

  it('reports LP and GP IRR, the LP multiple and the promote share', () => {
    for (const label of ['LP IRR', 'GP IRR', 'LP equity multiple', 'Promote share of profit']) {
      expect(wfTable.rows.map((r) => r[0])).toContain(label);
    }
  });

  it('quotes the same LP figures the waterfall module produces', () => {
    const wf = waterfallFromModel(runModel(healthy), structure);
    expect(value('LP IRR')).toBe(`${(wf.returns.lpIRR * 100).toFixed(1)}%`);
    expect(value('LP equity multiple')).toBe(`${wf.returns.lpEquityMultiple.toFixed(2)}×`);
  });

  it('runs the waterfall on the same capital stack the memo prints on page 1', () => {
    // A waterfall run on a different GP co-invest from the one in the capital
    // stack table splits the same equity two ways inside one document.
    const model = runModel(healthy);
    const wf = waterfallFromModel(model, structure);
    const implied = model.financing.gpCoInvest / model.financing.equityCommitment;
    expect(wf.config.gpCoInvestShare).toBeCloseTo(implied, 12);
    // Even when the supplied structure names its own share, the model's wins.
    const forced = buildMemo(healthy, { waterfall: { ...structure, gpCoInvestShare: 0 } });
    const note = forced.pages[1].blocks.find((b) => b.title === 'Promote structure');
    expect(note.text).toContain(`GP co-invest of ${(implied * 100).toFixed(0)}%`);
  });

  it('leaves the LP no better off than the undivided project return', () => {
    // Promote is paid out of the same cash flows. An LP IRR above the
    // project's levered IRR would mean the split created money.
    const model = runModel(healthy);
    const wf = waterfallFromModel(model, structure);
    expect(wf.returns.lpIRR).toBeLessThanOrEqual(model.returns.leveredIRR + 1e-12);
  });

  it('surfaces a structure it cannot run instead of dropping it silently', () => {
    // resolveWaterfall throws on a tier stack whose arithmetic has no answer.
    // Swallowing that would leave pre-promote returns under a memo that says a
    // promote structure exists.
    const broken = buildMemo(healthy, { waterfall: { tiers: [{ irrHurdle: 0.15, gpShare: 0.2 }] } });
    const block = broken.pages[1].blocks.find((b) => b.title === 'Distribution waterfall');
    expect(block.type).toBe('note');
    expect(block.text).toMatch(/could not be run/i);
    expect(block.text).toMatch(/before promote/i);
  });

  it('does not emit NaN or undefined with a waterfall attached', () => {
    const text = JSON.stringify(promoted);
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/undefined/);
  });
});

describe('promote disclosure', () => {
  const joined = (memo) => memo.pages[5].blocks.find((b) => b.type === 'disclosure').items.join(' ');

  it('states that returns are pre-promote when no structure is configured', () => {
    expect(joined(buildMemo(healthy))).toMatch(/no joint-venture waterfall/i);
    expect(joined(buildMemo(healthy))).toMatch(/before any promote/i);
  });

  it('stops claiming the model carries no waterfall once it carries one', () => {
    // The failure mode is a disclosure that contradicts the document it
    // travels with: the sentence outlived the limitation it described.
    const text = joined(buildMemo(healthy, { waterfall: { prefRate: 0.08 } }));
    expect(text).not.toMatch(/carries no joint-venture waterfall/i);
    expect(text).not.toMatch(/no joint-venture waterfall or promote structure/i);
    expect(text).toMatch(/waterfall is applied on the returns page/i);
  });

  it('still marks every other equity return in the document as pre-promote', () => {
    const text = joined(buildMemo(healthy, { waterfall: { prefRate: 0.08 } }));
    expect(text).toMatch(/before promote/i);
  });

  it('does not claim an applied waterfall when the structure was rejected', () => {
    // The failure mode: the lead-in note and the disclosure both branched on
    // the NUMBER of waterfall blocks, and the failure note is itself a block.
    // A rejected structure therefore printed "the waterfall below splits the
    // same cash flows" directly above the note saying it could not be run, and
    // a disclosure promising LP and GP figures the document does not contain.
    const rejected = buildMemo(healthy, { waterfall: { tiers: [{ irrHurdle: 0.12, gpShare: 0.2 }] } });
    const text = joined(rejected);
    expect(text).not.toMatch(/waterfall is applied on the returns page/i);
    expect(text).toMatch(/before any promote/i);

    const leadIn = rejected.pages[1].blocks.filter((b) => b.type === 'note' && !b.title);
    expect(leadIn.some((n) => /The waterfall below splits/i.test(n.text))).toBe(false);
    expect(leadIn.some((n) => /before any promote/i.test(n.text))).toBe(true);

    // And the whole document still carries no LP or GP figure to point at.
    expect(JSON.stringify(rejected)).not.toMatch(/LP IRR/);
  });

  it('labels the return measures table as pre-promote either way', () => {
    for (const memo of [buildMemo(healthy), buildMemo(healthy, { waterfall: { prefRate: 0.08 } })]) {
      const notes = memo.pages[1].blocks.filter((b) => b.type === 'note' && !b.title);
      expect(notes.some((n) => /before any promote/i.test(n.text))).toBe(true);
    }
  });
});
