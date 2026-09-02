import { toCSV, COLUMNS } from '../exportCsv';
import { runModel, calculateMetrics } from '../finance';
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
    // The exported going-in NOI nets property tax, capital reserves and
    // occupancy-scaled recoveries. The model's RENOVATION-period schedule — the
    // one feeding the IRR, Profit and Equity Multiple cells in the same row —
    // credits in-place income net of operating expense alone, and runs up to
    // 312 bps richer on the identical basis (Alamo Ridge: 8.20% against 5.08%).
    // An unqualified header lets a reader take the two for one number, so the
    // header has to carry the basis.
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
