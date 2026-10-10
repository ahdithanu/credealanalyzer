import { toCSV, COLUMNS } from '../exportCsv';
import { runModel, calculateMetrics } from '../finance';
import { waterfallFromModel } from '../waterfall';
import { SAMPLE_DEALS } from '../sampleDeals';

const withMetrics = (deal) => ({ ...deal, metrics: calculateMetrics(deal) });

const groundUp = withMetrics(SAMPLE_DEALS[0]);        // Houston, no in-place income
const acquisition = withMetrics(SAMPLE_DEALS[7]);     // Alamo Ridge, in-place income

/** Parse the export back the way a spreadsheet would, so the test reads cells. */
function parse(csv) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && csv[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

const cellsOf = (deals) => {
  const [headers, ...body] = parse(toCSV(deals));
  return body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
};

const cell = (deal, column) => cellsOf([deal])[0][column];

// The two going-in headers, named once so a change to the wording they carry
// is a one-line edit and not a hunt through four assertions.
const GOING_IN_CAP = 'Going-In Cap Rate, net of tax & reserves (%)';
const GOING_IN_NOI = 'Going-In NOI, net of tax & reserves ($)';

describe('column naming', () => {
  it('gives every column a distinct name', () => {
    const names = COLUMNS.map(([label]) => label);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps going-in cap rate and yield on cost as separate, separately named columns', () => {
    // Regression on the defect this file exists for: a metric exported under
    // the name of a different metric. These two are not interchangeable —
    // one prices in-place income against price paid, the other prices
    // stabilized income against total cost — and a merged column would make a
    // ground-up deal look as though it had a going-in yield.
    const names = COLUMNS.map(([label]) => label);
    expect(names).toContain('Yield on Cost (%)');
    expect(names).toContain(GOING_IN_CAP);
    expect(names).not.toContain('Cap Rate (%)');
    expect(GOING_IN_CAP).not.toBe('Yield on Cost (%)');
  });

  it('qualifies the going-in columns with the NOI definition they are struck on', () => {
    // A cap rate is only comparable to another cap rate struck the same way,
    // and there are two conventions in circulation: net of property tax and
    // reserves, and gross of them. The gap is most of 200 bps on a Texas asset,
    // which is larger than the difference between a good deal and a bad one, so
    // the header names the convention rather than leaving a reader to assume it.
    //
    // This header once also guarded against a divergence INSIDE the row: the
    // renovation-period schedule feeding the IRR, Profit and Equity Multiple
    // cells credited in-place income net of operating expense alone and ran
    // 312 bps richer than this column on the identical basis. finance.js now
    // charges tax and reserves through the renovation months, and the two
    // reconcile exactly — see 'reports the same in-place NOI it charges, on
    // every deal that has one' and 'prices a renovation month exactly as the
    // operating schedule prices the same asset' in finance.test.js, which is
    // where that invariant is asserted rather than merely disclosed in a label.
    for (const label of [GOING_IN_CAP, GOING_IN_NOI]) {
      expect(label).toMatch(/net of tax & reserves/);
    }
  });

  it('states the unit of every numeric column in its own name', () => {
    const numericish = /(\$|%|bps|\(x\)|DSCR|Months)/;
    const unlabelled = COLUMNS
      .map(([label]) => label)
      .filter((label) => /Rate|Cost|Equity|NOI|Yield|Spread|Price|Proceeds|Profit|IRR|Multiple|Occupancy|Basis|Interest/.test(label))
      .filter((label) => !numericish.test(label))
      // Text columns naming a category rather than a quantity.
      .filter((label) => !['Debt Sizing Basis', 'Binding Debt Constraint'].includes(label));
    expect(unlabelled).toEqual([]);
  });
});

describe('percent columns', () => {
  it('scales the going-in cap rate exactly once', () => {
    // model.operating carries the ratio (0.0508) and calculateMetrics carries a
    // percent-scaled twin (5.08). Scaling the twin again ships 508%; forgetting
    // to scale the ratio ships 0.05%. Both have shipped in tools like this one.
    const ratio = runModel(SAMPLE_DEALS[7]).operating.goingInCapRate;
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
    // Two decimal places is the column's own rounding; the point of the
    // assertion is the factor of 100, not the last digit.
    expect(Number(cell(acquisition, GOING_IN_CAP))).toBeCloseTo(ratio * 100, 2);
  });

  it('scales break-even occupancy exactly once, as a percentage of the rent roll', () => {
    const ratio = runModel(SAMPLE_DEALS[0]).operating.breakEvenOccupancy;
    const exported = Number(cell(groundUp, 'Break-even Occupancy (%)'));
    expect(exported).toBeCloseTo(ratio * 100, 1);
    // An occupancy is tens of percent. A cell under 1 is the unscaled ratio
    // leaking through a column labelled '%'.
    expect(exported).toBeGreaterThan(1);
  });

  it('agrees with the going-in cap rate the flat metric bag reports', () => {
    // Two conventions for one quantity is how a double-scaled column happens.
    // Whichever side is read, the exported figure must be the same number.
    expect(Number(cell(acquisition, GOING_IN_CAP)))
      .toBeCloseTo(calculateMetrics(SAMPLE_DEALS[7]).goingInCapRate, 2);
  });
});

describe('unknowns', () => {
  it('exports a ground-up going-in cap rate as n/a, never as 0 or as yield on cost', () => {
    expect(runModel(SAMPLE_DEALS[0]).operating.goingInCapRate).toBeNull();
    expect(cell(groundUp, GOING_IN_CAP)).toBe('n/a');
    expect(cell(groundUp, GOING_IN_NOI)).toBe('n/a');
    expect(cell(groundUp, GOING_IN_CAP)).not.toBe(cell(groundUp, 'Yield on Cost (%)'));
  });

  it('exports an unmodellable deal as n/a rather than a row of zeroes', () => {
    const empty = withMetrics({ name: 'Napkin', location: '', holdPeriod: 0 });
    const row = cellsOf([empty])[0];
    expect(row['Break-even Occupancy (%)']).toBe('n/a');
    expect(row[GOING_IN_CAP]).toBe('n/a');
    expect(row['Levered IRR (%)']).toBe('n/a');
  });
});

describe('debt sizing provenance', () => {
  it('distinguishes a covenant-sized loan from one that fell out of the equity input', () => {
    // The loan balance column is identical either way; only these two columns
    // say whether the number is the lender's answer or the sponsor's input.
    const sized = withMetrics({ ...SAMPLE_DEALS[0], sizeDebtToConstraints: true });
    expect(cell(groundUp, 'Debt Sizing Basis')).toBe('Equity share input');
    expect(cell(groundUp, 'Binding Debt Constraint')).toBe('n/a');
    expect(cell(sized, 'Debt Sizing Basis')).toMatch(/^Lender constraint/);
    expect(cell(sized, 'Binding Debt Constraint')).toBe('Loan to cost');
  });

  it('does not report a constraint as applied when none was', () => {
    // Two false labels, both on deals the user explicitly put in Credit box
    // mode. A model that never reached a schedule carries no sizing at all and
    // read "Equity share input" — the opposite of what was asked for. One where
    // no lender test could be evaluated carries a sizing whose loanAmount is
    // null and read "Lender constraint (unconverged)" — a constraint that was
    // never applied, described as one that merely had not settled.
    const noSchedule = withMetrics({ ...SAMPLE_DEALS[0], sizeDebtToConstraints: true, holdPeriod: 0 });
    expect(runModel({ ...SAMPLE_DEALS[0], sizeDebtToConstraints: true, holdPeriod: 0 }).financing.sizing).toBeNull();
    expect(cell(noSchedule, 'Debt Sizing Basis')).toBe('Lender constraint requested, not applied');

    // Every test nulled out: no basis, no coverage floor, no debt yield floor.
    const untestable = { ...SAMPLE_DEALS[0], sizeDebtToConstraints: true,
      debtSizing: { maxLTC: Number.NaN, minDSCR: 0, minDebtYield: 0 } };
    const sizing = runModel(untestable).financing.sizing;
    expect(sizing.loanAmount).toBeNull();
    expect(cell(withMetrics(untestable), 'Debt Sizing Basis'))
      .toBe('Lender constraint requested, no test evaluable');
  });

  it('names coverage as the binding test when coverage is what binds', () => {
    const expensive = withMetrics({ ...SAMPLE_DEALS[0], sizeDebtToConstraints: true, interestRate: 13 });
    const sizing = runModel({ ...SAMPLE_DEALS[0], sizeDebtToConstraints: true, interestRate: 13 })
      .financing.sizing;
    expect(sizing.bindingConstraint).toBe('dscr');
    expect(cell(expensive, 'Binding Debt Constraint')).toBe('Debt service coverage');
  });
});

describe('toCSV', () => {
  it('emits one header row and one row per deal', () => {
    const rows = parse(toCSV([groundUp, acquisition]));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(COLUMNS.map(([label]) => label));
  });

  it('quotes a value containing a comma so the row does not gain a column', () => {
    const comma = withMetrics({ ...SAMPLE_DEALS[0], name: 'Houston, TX Portfolio' });
    const rows = parse(toCSV([comma]));
    expect(rows[1]).toHaveLength(COLUMNS.length);
    expect(rows[1][0]).toBe('Houston, TX Portfolio');
  });

  it('exports every sample deal without emitting NaN or undefined', () => {
    const csv = toCSV(SAMPLE_DEALS.map(withMetrics));
    expect(csv).not.toMatch(/NaN/);
    expect(csv).not.toMatch(/undefined/);
  });
});

/**
 * The export used to carry no LP or GP figure at all, so a pipeline exported
 * for an allocation discussion showed only project-level returns however the
 * promote was struck.
 */
describe('promote columns', () => {
  const structure = {
    prefRate: 0.08,
    catchUp: { enabled: true, gpShare: 1.0, targetPromoteShare: null },
    tiers: [{ irrHurdle: 0.15, gpShare: 0.20 }, { irrHurdle: null, gpShare: 0.30 }],
  };
  const promoted = withMetrics({ ...SAMPLE_DEALS[0], waterfall: structure });
  // Not open-ended at the top: resolveWaterfall() refuses it rather than
  // inventing a split for the dollars above the last hurdle.
  const rejected = withMetrics({ ...SAMPLE_DEALS[0], waterfall: { tiers: [{ irrHurdle: 0.15, gpShare: 0.2 }] } });

  const PROMOTE_CELLS = [
    'Preferred Return (%)', 'Residual GP Promote (%)', 'LP IRR (%)', 'LP Equity Multiple (x)',
    'GP IRR (%)', 'To LP ($)', 'To GP ($)', 'GP Promote, net ($)', 'Promote Clawback ($)',
    'Promote Share of Profit (%)',
  ];

  it('says a deal has no promote structure rather than exporting zeroes', () => {
    // A 0 in the promote column is a claim that the sponsor earned nothing on
    // this deal. "No structure was run" is a different fact, and the state
    // column is what tells the two apart when every figure beside it is n/a.
    const row = cellsOf([groundUp])[0];
    expect(groundUp.waterfall).toBeUndefined();
    expect(row['Promote Structure']).toBe('None configured');
    for (const label of PROMOTE_CELLS) expect(row[label]).toBe('n/a');
  });

  it('carries the LP and GP split once a structure is on the deal', () => {
    const wf = waterfallFromModel(runModel(promoted), structure);
    const row = cellsOf([promoted])[0];
    expect(row['Promote Structure']).toBe('Applied');
    expect(Number(row['LP IRR (%)'])).toBeCloseTo(wf.returns.lpIRR * 100, 2);
    expect(Number(row['LP Equity Multiple (x)'])).toBeCloseTo(wf.returns.lpEquityMultiple, 2);
    expect(Number(row['To LP ($)'])).toBeCloseTo(wf.totals.lpDistributions, 0);
    expect(Number(row['To GP ($)'])).toBeCloseTo(wf.totals.gpDistributions, 0);
    expect(Number(row['GP Promote, net ($)'])).toBeCloseTo(wf.totals.gpPromoteNet, 0);
    // The stated terms travel with the outcome, so a row cannot be read as a
    // 20% promote when it was struck at 30% above the hurdle.
    expect(Number(row['Preferred Return (%)'])).toBeCloseTo(8, 6);
    expect(Number(row['Residual GP Promote (%)'])).toBeCloseTo(30, 6);
  });

  it('reconciles the split against the project-level columns beside it', () => {
    // Promote is paid out of the same equity cash flows the row already
    // reports. LP + GP distributions that did not sum to them would mean the
    // two halves of the row came from different models.
    const row = cellsOf([promoted])[0];
    const wf = waterfallFromModel(runModel(promoted), structure);
    expect(Number(row['To LP ($)']) + Number(row['To GP ($)']))
      .toBeCloseTo(wf.totals.distributions, 0);
    // And the LP cannot beat the undivided deal: a split does not create money.
    expect(Number(row['LP IRR (%)'])).toBeLessThanOrEqual(Number(row['Levered IRR (%)']) + 1e-9);
  });

  it('does not report a promote for a structure the engine refuses', () => {
    // The failure mode this guards: a rejected structure exporting as though no
    // structure existed, or worse as an applied one with zeroed figures.
    const row = cellsOf([rejected])[0];
    expect(row['Promote Structure']).toMatch(/^Configured, not applied — /);
    expect(row['Promote Structure']).toMatch(/open-ended/i);
    for (const label of PROMOTE_CELLS) expect(row[label]).toBe('n/a');
  });

  it('distinguishes a structure with no cash flow to split from one never set', () => {
    const noSchedule = withMetrics({ ...SAMPLE_DEALS[0], holdPeriod: 0, waterfall: structure });
    const row = cellsOf([noSchedule])[0];
    expect(row['Promote Structure']).toBe('Configured, no equity schedule to split');
    for (const label of PROMOTE_CELLS) expect(row[label]).toBe('n/a');
  });

  it('splits the capital stack the model funded, not one stored with the structure', () => {
    // One deal cannot export a promote struck on a different equity split from
    // the debt and equity columns in the same row.
    const model = runModel(promoted);
    const implied = model.financing.gpCoInvest / model.financing.equityCommitment;
    const forced = withMetrics({ ...SAMPLE_DEALS[0], waterfall: { ...structure, gpCoInvestShare: 0 } });
    expect(implied).toBeGreaterThan(0);
    expect(cellsOf([forced])[0]['To GP ($)']).toBe(cellsOf([promoted])[0]['To GP ($)']);
  });

  it('exports every sample deal promoted without emitting NaN or undefined', () => {
    const csv = toCSV(SAMPLE_DEALS.map((d) => withMetrics({ ...d, waterfall: structure })));
    expect(csv).not.toMatch(/NaN/);
    expect(csv).not.toMatch(/undefined/);
  });
});

describe('debt sizing basis', () => {
  it('reads the request off the model, not off the deal record', () => {
    // `financing.sizingRequested` exists so a caller does not have to reach back
    // to the deal record to tell "never asked" from "asked and could not be
    // served". This column was getting the answer right only by consulting
    // `d.sizeDebtToConstraints` — the guessing the flag was added to end, and a
    // reach past the model the exporter was handed.
    const asked = withMetrics({ ...SAMPLE_DEALS[0], holdPeriod: 0, sizeDebtToConstraints: true });
    expect(asked.metrics.model.financing.sizingRequested).toBe(true);
    expect(cell(asked, 'Debt Sizing Basis')).toBe('Lender constraint requested, not applied');

    const never = withMetrics({ ...SAMPLE_DEALS[0], holdPeriod: 0 });
    expect(cell(never, 'Debt Sizing Basis')).toBe('Equity share input');

    const sized = withMetrics({ ...SAMPLE_DEALS[0], sizeDebtToConstraints: true });
    expect(cell(sized, 'Debt Sizing Basis')).toMatch(/^Lender constraint/);
    expect(sized.metrics.model.financing.sizing.honoured).toBe(true);
  });

  it('does not read the model as unsized when the deal record is stripped', () => {
    // The model is the record of what happened. A pipeline row rebuilt from a
    // model alone must still export the right basis.
    const sized = withMetrics({ ...SAMPLE_DEALS[0], sizeDebtToConstraints: true });
    const { sizeDebtToConstraints, ...withoutFlag } = sized;
    expect(cell(withoutFlag, 'Debt Sizing Basis')).toBe(cell(sized, 'Debt Sizing Basis'));
  });
});

describe('going-in NOI on a deal bought empty', () => {
  it('reports the in-place NOI it actually charges, even with no cap rate to quote', () => {
    // Dallas Office TI is a fit-out bought empty: it has no going-in cap RATE
    // (a pricing multiple on negative income is not a yield) but it has a
    // perfectly knowable in-place NOI, and the schedule charges it. Exporting
    // n/a for the NOI beside IRR, Profit and Equity Multiple cells that DO
    // reflect that carry is the same-row divergence the column exists to close.
    const ti = withMetrics(SAMPLE_DEALS.find((d) => d.constructionType === 'ti'));
    const model = ti.metrics.model;
    expect(model.operating.goingInCapUnavailable).toBe('no-in-place-income');
    expect(cell(ti, 'Going-In Cap Rate, net of tax & reserves (%)')).toBe('n/a');
    const noi = Number(cell(ti, 'Going-In NOI, net of tax & reserves ($)'));
    expect(noi).toBeLessThan(0);
    expect(noi).toBeCloseTo(model.months[0].noi * 12, 0);
  });
});
