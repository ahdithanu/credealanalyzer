/**
 * Investment committee memorandum.
 *
 * Builds a paginated document model from a deal and its underwriting output.
 * Pure data: the renderer is generic over block types, so what the memo says
 * can be tested without rendering anything.
 *
 * Two rules govern this file, because unlike every other screen this artifact
 * leaves the building:
 *
 *   1. Every figure is derived from the live model at build time. Nothing is
 *      transcribed, and each block records the `source` it was bound from so
 *      a reader can ask where a number came from.
 *   2. Limitations travel with the document. A memo built on seed market data
 *      says so on its own page, not in a caveat someone can forget to repeat.
 */

import { runModel } from './finance';
import { waterfallFromModel } from './waterfall';
import { validate, DEFAULT_COVENANTS } from './validation';
import { runScenarios, sensitivityGrid, breakeven } from './sensitivity';
import { findMarket } from './markets';
import { scoreMarket } from './marketScore';
import { overrides, firmDefault, FIRM_DEFAULTS } from './firmDefaults';
import { propertyTypes, constructionTypes } from './propertyTypes';
import { money, money0, thousands, pct, pctRaw, mult, bps, num, acct, NA } from './format';

/**
 * Mechanical screening test against the firm's stated thresholds.
 *
 * Deliberately not an investment recommendation: it reports which stated
 * criteria the deal meets. The judgment stays with the committee, and the
 * wording has to make that obvious on the page.
 */
export function screeningVerdict(model, covenants = {}) {
  const c = { ...DEFAULT_COVENANTS, ...covenants };
  if (!model || model.incomplete) {
    return { verdict: 'Incomplete', tests: [], summary: 'The model is incomplete and cannot be screened.' };
  }
  const { operating, financing } = model;
  const tests = [
    {
      label: 'Development spread',
      actual: operating.developmentSpreadBps,
      threshold: c.minDevSpreadBps,
      pass: operating.developmentSpreadBps !== null && operating.developmentSpreadBps >= c.minDevSpreadBps,
      format: (v) => (v === null ? NA : bps(v)),
    },
    {
      label: 'Stabilized DSCR',
      actual: operating.minStabilizedDSCR,
      threshold: c.minDSCR,
      pass: (operating.minStabilizedDSCR ?? 0) >= c.minDSCR,
      format: mult,
    },
    {
      label: 'Debt yield',
      actual: operating.debtYield,
      threshold: c.minDebtYield,
      pass: (operating.debtYield ?? 0) >= c.minDebtYield,
      format: (v) => pct(v, 2),
    },
    {
      label: 'Loan to cost',
      actual: financing.ltc,
      threshold: c.maxLTC,
      // An unmeasurable ratio fails the test rather than passing it by
      // default: `null <= limit` is true, which would print a green tick for a
      // leverage figure the model could not compute.
      pass: (financing.ltc ?? Infinity) <= c.maxLTC,
      inverted: true,
      format: (v) => pct(v, 1),
    },
  ];

  const failed = tests.filter((t) => !t.pass);
  const verdict = failed.length === 0 ? 'Meets all stated criteria'
    : failed.length === 1 ? 'Meets criteria with one exception'
    : 'Does not meet stated criteria';

  return {
    verdict,
    tests,
    failedCount: failed.length,
    summary: failed.length === 0
      ? 'The deal meets every threshold in the firm assumption set. This is a mechanical screen, not a recommendation.'
      : `The deal falls short on ${failed.map((t) => t.label.toLowerCase()).join(' and ')}. This is a mechanical screen, not a recommendation.`,
  };
}


/**
 * Presentation for each governed assumption: a human label and one formatter
 * used for BOTH the underwritten value and the firm default. Formatting them
 * separately is how a document ends up reading "3.0% against 3".
 */
const FIELD_PRESENTATION = {
  vacancyRate:           { label: 'Vacancy',                fmt: (v) => pctRaw(v, 1) },
  operatingExpenseRatio: { label: 'OpEx ratio (excl. tax)', fmt: (v) => pctRaw(v, 1) },
  downPayment:           { label: 'Equity share',           fmt: (v) => pctRaw(v, 1) },
  interestRate:          { label: 'All-in rate',            fmt: (v) => pctRaw(v, 2) },
  loanTerm:              { label: 'Amortization',           fmt: (v) => `${v} yrs` },
  exitCapRate:           { label: 'Exit cap rate',          fmt: (v) => pctRaw(v, 2) },
  rentGrowth:            { label: 'Rent growth',            fmt: (v) => pct(v, 1) },
  expenseGrowth:         { label: 'Expense growth',         fmt: (v) => pct(v, 1) },
  assessmentGrowth:      { label: 'Assessed value growth',  fmt: (v) => pct(v, 1) },
  costOfSalePct:         { label: 'Cost of sale',           fmt: (v) => pct(v, 1) },
  gpCoInvestShare:       { label: 'GP co-invest share',     fmt: (v) => pct(v, 0) },
};

/** Label a governed field for a reader; falls back to the raw key. */
export function fieldLabel(field) {
  return FIELD_PRESENTATION[field]?.label ?? field;
}

/** One assumption row, with both columns rendered through the same formatter. */
function governedRow(field, deal) {
  const p = FIELD_PRESENTATION[field];
  const value = deal[field] ?? deal.assumptions?.[field];
  const def = firmDefault(field, deal.propertyType);
  return [
    p.label,
    value === undefined ? NA : p.fmt(value),
    def === undefined ? '—' : p.fmt(def),
  ];
}

/** Why a going-in cap rate does not exist, in the engine's own three cases. */
const GOING_IN_UNAVAILABLE = {
  'ground-up': 'No income in place at acquisition; a ground-up deal has no going-in yield',
  'no-in-place-income': 'No in-place revenue is underwritten at acquisition, so there is no going-in NOI to price',
  'no-acquisition-basis': 'Income is in place, but no acquisition basis is underwritten to price it against',
  'no-revenue-base': 'No stabilised rent roll to measure the in-place occupancy against',
};

/**
 * The equity share row, reading off the model rather than the deal whenever the
 * loan was sized to the credit box.
 */
function sizedEquityRow(deal, model) {
  const row = governedRow('downPayment', deal);
  if (!model.financing.sizing || !(model.budget.baseProjectCost > 0)) return row;
  const effective = (model.financing.equityCommitment / model.budget.baseProjectCost) * 100;
  return [row[0], `${FIELD_PRESENTATION.downPayment.fmt(effective)} (sized)`, row[2]];
}

const kv = (label, value, source) => ({ label, value, source });

/**
 * The lender's three sizing tests, in words a reader outside the deal team can
 * act on. `sizeDebt()` keys them 'ltc' / 'dscr' / 'debtYield'; a memo that
 * printed the key would be asking its reader to know the codebase.
 */
const CONSTRAINT_LABEL = {
  ltc: 'loan to cost',
  dscr: 'debt service coverage',
  debtYield: 'debt yield',
};

/**
 * The debt sizing paragraph.
 *
 * A loan sized to a covenant and a loan sized to an equity percentage are
 * materially different claims about the same dollar figure — the first is the
 * lender's answer, the second is the sponsor's input — and the balance on the
 * capital stack table reads identically either way. Naming the binding test is
 * the whole point: an LTC-bound deal is solved with more equity, a
 * coverage-bound deal is not solved with equity at all.
 */
function debtSizingNote(sizing) {
  if (!sizing) {
    return {
      type: 'note',
      title: 'Debt sizing',
      text: 'The loan is the residual of the underwritten equity share, not a lender-sized amount. It has not been tested against loan-to-cost, coverage or debt yield limits at sizing; the screen on the summary page tests the resulting balance after the fact.',
    };
  }

  if (!sizing.bindingConstraint) {
    return {
      type: 'note',
      title: 'Debt sizing',
      text: 'Constrained sizing was requested, but no lender test could be evaluated on this deal — there is no basis, no coverage floor and no debt yield floor to size against — so the loan falls back to the underwritten equity share. The balance below is not a lender-sized amount.',
    };
  }

  const other = ['ltc', 'dscr', 'debtYield']
    .filter((k) => k !== sizing.bindingConstraint)
    .map((k) => {
      const limit = sizing.constraints?.[k];
      // An untested constraint is reported as untested. Printing it as $0 would
      // make it look like the tightest limit of the three.
      return `${CONSTRAINT_LABEL[k]} ${limit === null || limit === undefined ? 'not evaluated' : money0(limit)}`;
    })
    .join(', ');

  const settled = sizing.converged
    ? ''
    : ` The sizing loop did not settle within ${sizing.passes} passes — the loan capitalises interest, which moves basis, which moves the loan — so the balance shown is the last iterate rather than a converged solution.`;

  return {
    type: 'note',
    title: 'Debt sizing',
    text: `The loan is sized to the binding lender constraint, not to the equity share on the appendix page. Of the three tests, ${CONSTRAINT_LABEL[sizing.bindingConstraint]} binds at ${money0(sizing.loanAmount)} against ${other}. The equity share is the residual of that loan, not an input.${settled}`,
  };
}

/**
 * Returns after the promote, when a structure has been configured.
 *
 * `resolveWaterfall()` throws on a tier stack whose arithmetic has no answer.
 * That refusal has to reach the page rather than be swallowed: a memo that
 * silently dropped the waterfall would present pre-promote returns under a
 * document that says a promote structure exists.
 */
function waterfallBlocks(model, config) {
  // The capital stack on page 1 is the model's, and waterfallFromModel derives
  // the co-invest from that same stack. A supplied structure carrying its own
  // gpCoInvestShare would split one equity commitment two ways inside a single
  // document, so the model's share wins here.
  const structure = { ...config };
  delete structure.gpCoInvestShare;

  let wf;
  try {
    wf = waterfallFromModel(model, structure);
  } catch (e) {
    // `applied: false`. Callers branched on block COUNT, and the failure note is
    // itself a block — so a rejected structure printed "the waterfall below
    // splits the same cash flows" above the note saying it could not be run, and
    // a disclosure page claiming LP and GP figures the document does not carry.
    return {
      applied: false,
      blocks: [{
        type: 'note',
        title: 'Distribution waterfall',
        text: `A promote structure was supplied but could not be run: ${String(e.message).replace(/^waterfall:\s*/, '')}. Every return in this memorandum is therefore a project-level figure before promote.`,
      }],
    };
  }

  const cfg = wf.config;
  const tierText = cfg.tiers
    .map((t) => (t.irrHurdle === null
      ? `${pct(t.gpShare, 0)} above the top hurdle`
      : `${pct(t.gpShare, 0)} to a ${pct(t.irrHurdle, 1)} IRR`))
    .join(', then ');

  const shortfall = wf.returns.capitalShortfall + wf.returns.prefShortfall;

  return { applied: true, blocks: [
    {
      type: 'table',
      title: 'Distribution waterfall',
      source: 'waterfall.waterfallFromModel',
      headers: ['Measure', 'Value', 'Basis'],
      align: ['l', 'r', 'l'],
      rows: [
        ['LP IRR', pct(wf.returns.lpIRR), 'LP cash flows after pref, return of capital and promote'],
        ['GP IRR', pct(wf.returns.gpIRR), 'GP co-invest and promote, net of clawback'],
        ['LP equity multiple', mult(wf.returns.lpEquityMultiple), 'LP distributions ÷ LP contributions'],
        ['GP promote', money0(wf.totals.gpPromoteNet), 'Promote earned, net of any clawback'],
        ['Promote share of profit', pct(wf.returns.gpPromoteShareOfProfit, 1), 'Net promote ÷ total equity profit'],
        ['Preferred return paid', money0(wf.totals.prefPaid), `${pct(cfg.prefRate, 1)} ${cfg.prefCompounding ? 'compounding' : 'simple'} on unreturned capital`],
        ['Unpaid preferred return', money0(wf.returns.prefShortfall), 'Accrued and still owed to the investor class at sale'],
        ['Unreturned capital', money0(wf.returns.capitalShortfall), 'Contributions never returned to the investor class'],
      ],
    },
    {
      type: 'note',
      title: 'Promote structure',
      text: `Pref ${pct(cfg.prefRate, 1)} ${cfg.prefCompounding ? 'compounding' : 'simple'}, quoted as ${cfg.prefRateBasis === 'nominal' ? 'a nominal annual rate divided by twelve' : 'an effective annual rate'}, accruing on unreturned capital; ${cfg.returnOfCapitalFirst ? 'capital is returned before pref is paid' : 'pref is paid before capital is returned'}; ${cfg.catchUp.enabled ? `GP catch-up at ${pct(cfg.catchUp.gpShare, 0)} to a ${pct(cfg.catchUp.targetPromoteShare, 0)} promote` : 'no GP catch-up'}; residual promote ${tierText}. GP co-invest of ${pct(cfg.gpCoInvestShare, 0)} ranks pari passu with the LP, so promote is the only preferential GP economics. ${
        wf.totals.gpClawback > 0
          ? `Promote of ${money0(wf.totals.gpClawback)} was clawed back at sale because the investor class ended short.`
          : 'No clawback was triggered.'
      }${shortfall > 0 ? ` The investor class ends ${money0(shortfall)} short of capital and accrued pref, so the promote tiers above it were never reached.` : ''}`,
    },
  ] };
}

/**
 * Build the memo.
 * @returns {{meta:Object, pages:Array, provenance:Object}}
 */
export function buildMemo(deal, {
  preparedBy = deal.owner ?? 'Unattributed',
  firm = 'Investment Committee',
  date = new Date(),
  covenants = {},
  // A promote structure is not part of the deal inputs the model runs on, so
  // it is carried separately. Absent, the memo says so on the disclosure page
  // rather than leaving the reader to assume the returns are post-promote.
  waterfall = deal.waterfall ?? null,
} = {}) {
  const model = runModel(deal);
  const flags = validate(model, deal, covenants);
  const screen = screeningVerdict(model, covenants);
  const ov = overrides(deal);
  const market = findMarket(deal.location);
  const scored = market ? scoreMarket(market, { propertyType: deal.propertyType }) : null;
  const scenarios = runScenarios(deal);
  const grid = sensitivityGrid(deal, { xVar: 'exitCapRate', yVar: 'interestRate', metric: 'leveredIRR' });

  const { budget, financing, operating, returns, exit, timeline } = model;
  const typeName = propertyTypes[deal.propertyType]?.name ?? deal.propertyType;
  const constName = constructionTypes[deal.constructionType]?.name ?? deal.constructionType;

  const pages = [];

  // 1 — Summary ------------------------------------------------------------
  pages.push({
    n: 1,
    title: 'Investment Summary',
    blocks: [
      {
        type: 'facts',
        items: [
          kv('Property type', typeName, 'deal.propertyType'),
          kv('Strategy', constName, 'deal.constructionType'),
          kv('Market', deal.location, 'deal.location'),
          kv('Program', deal.program ?? '—', 'deal.program'),
          kv('Total development cost', money0(budget.totalProjectCost), 'model.budget.totalProjectCost'),
          kv('Peak equity', money0(returns.peakEquity), 'model.returns.peakEquity'),
          kv('Hold period', `${(timeline.operatingMonths / 12).toFixed(1)} yrs`, 'deal.holdPeriod'),
          kv('Construction', `${timeline.constructionMonths} mo`, 'model.timeline.constructionMonths'),
        ],
      },
      {
        type: 'verdict',
        verdict: screen.verdict,
        summary: screen.summary,
        pass: screen.failedCount === 0,
        tests: screen.tests.map((t) => ({
          label: t.label,
          actual: t.format(t.actual),
          threshold: `${t.inverted ? 'max' : 'min'} ${t.format(t.threshold)}`,
          pass: t.pass,
        })),
      },
      {
        type: 'headline',
        items: [
          kv('Levered IRR', pct(returns.leveredIRR), 'model.returns.leveredIRR'),
          kv('Equity multiple', mult(returns.equityMultiple), 'model.returns.equityMultiple'),
          kv('Yield on cost', pct(operating.yieldOnCost, 2), 'model.operating.yieldOnCost'),
          kv('Dev spread', operating.developmentSpreadBps === null ? NA : bps(operating.developmentSpreadBps), 'model.operating.developmentSpreadBps'),
        ],
      },
      {
        type: 'table',
        title: 'Sources & uses',
        source: 'model.budget.lines',
        headers: ['Use', '$000', '% TDC'],
        align: ['l', 'r', 'r'],
        rows: budget.lines.map((l) => [l.label, thousands(l.amount), pct(l.amount / (budget.totalProjectCost || 1), 1)]),
        total: ['Total development cost', thousands(budget.totalProjectCost), '100.0%'],
      },
      {
        type: 'table',
        title: 'Capital stack',
        source: 'model.financing',
        headers: ['Source', 'Amount', '% TDC'],
        align: ['l', 'r', 'r'],
        rows: [
          ['Senior debt', money0(financing.permanentLoanBalance), pct(financing.permanentLoanBalance / (budget.totalProjectCost || 1), 1)],
          ['LP equity', money0(financing.lpEquity), pct(financing.lpEquity / (budget.totalProjectCost || 1), 1)],
          ['GP co-invest', money0(financing.gpCoInvest), pct(financing.gpCoInvest / (budget.totalProjectCost || 1), 1)],
        ],
      },
    ],
  });

  // 2 — Returns ------------------------------------------------------------
  // The waterfall is run only when a structure exists, and its absence is a
  // disclosure rather than a blank space: returns with no waterfall behind them
  // are pre-promote, and nothing on the page says so otherwise.
  const wf = waterfall ? waterfallBlocks(model, waterfall) : { applied: false, blocks: [] };
  const wfBlocks = wf.blocks;
  const wfApplied = wf.applied;
  // Which of the three tests failed is decided by the engine, not re-derived
  // here: the same null used to print "a ground-up deal has no going-in yield"
  // on a tenant-improvement deal, and on an acquisition carrying $3.4m of
  // in-place income whose purchase price was simply blank.
  const goingInBasis = operating.goingInCapRate !== null
    ? `In-place NOI net of property tax, reserves and occupancy-scaled recoveries ÷ acquisition basis of ${money0(operating.acquisitionBasis)}, excluding construction draws. The renovation-period cash flows credit in-place income net of operating expense alone and so run richer than this yield.`
    : GOING_IN_UNAVAILABLE[operating.goingInCapUnavailable]
      ?? 'The going-in yield could not be measured on this deal';

  pages.push({
    n: 2,
    title: 'Returns & Capitalisation',
    blocks: [
      {
        type: 'table',
        title: 'Return measures',
        source: 'model.returns',
        headers: ['Measure', 'Value', 'Basis'],
        align: ['l', 'r', 'l'],
        rows: [
          ['Levered IRR', pct(returns.leveredIRR), 'Monthly equity cash flows, solved by bisection'],
          ['Unlevered IRR', pct(returns.unleveredIRR), 'Project cash flows before debt'],
          ['Equity multiple', mult(returns.equityMultiple), 'Distributions ÷ contributions'],
          ['Peak equity', money0(returns.peakEquity), 'Maximum cumulative outflow'],
          ['Total contributed', money0(returns.totalEquityInvested), 'Sum of negative equity flows'],
          ['Total distributed', money0(returns.totalDistributions), 'Sum of positive equity flows'],
          ['Profit', money0(returns.profit), 'Net of all equity flows'],
        ],
      },
      {
        type: 'note',
        text: wfApplied
          ? 'The measures above are project-level equity returns, before any promote. The waterfall below splits the same cash flows between the limited partners and the sponsor.'
          : 'No promote structure has been applied to this deal, so the measures above are project-level equity returns, before any promote. LP and GP outcomes will be lower and higher than these respectively.',
      },
      ...wfBlocks,
      {
        type: 'table',
        title: 'Operating & credit',
        source: 'model.operating',
        headers: ['Measure', 'Value', 'Test'],
        align: ['l', 'r', 'l'],
        rows: [
          ['Stabilized NOI', money0(operating.stabilizedNOI), `Stabilizes month ${operating.stabilizationMonth}`],
          ['Yield on cost', pct(operating.yieldOnCost, 2), 'Stabilized NOI ÷ total development cost'],
          // A ratio on model.operating, so pct() scales it once. The flat
          // metric bag carries a percent-scaled twin of this figure; reading
          // that one here would print 685%.
          ['Going-in cap rate', pct(operating.goingInCapRate, 2), goingInBasis],
          ['Exit cap rate', pctRaw(deal.exitCapRate), 'Underwritten'],
          ['Development spread', operating.developmentSpreadBps === null ? NA : bps(operating.developmentSpreadBps), 'Yield on cost less exit cap'],
          ['DSCR, stabilized', mult(operating.minStabilizedDSCR), 'Minimum rolling year from stabilization'],
          ['DSCR, incl. lease-up', mult(operating.minDSCR), 'Minimum rolling year over the full hold'],
          ['Debt yield', pct(operating.debtYield, 2), 'Stabilized NOI ÷ loan balance'],
          ['Loan to cost', pct(financing.ltc, 1), 'Permanent balance ÷ total project cost'],
          // Also a ratio: 0.83 is 83% of the rent roll, not 0.83% of it.
          ['Break-even occupancy', pct(operating.breakEvenOccupancy, 1), 'Operating cost, tax, reserves and debt service ÷ gross potential revenue, both struck at full occupancy'],
          // model.operating.stabilizedOccupancy is the AVERAGE occupancy over
          // the twelve-month stabilisation window, which finance.js records can
          // still be leasing up on a short hold — not the vacancy assumption.
          // Labelled as the underwritten input it read +993 bps where the
          // figure printed was -4,390 bps: a 5,383 bps gap and the wrong sign.
          ['Average stabilised-year occupancy', pct(operating.stabilizedOccupancy, 1),
            'Mean occupancy across the twelve-month stabilisation window'],
          ['Occupancy cushion', operating.breakEvenOccupancy === null || operating.stabilizedOccupancy === null
            ? NA
            : bps((operating.stabilizedOccupancy - operating.breakEvenOccupancy) * 10000, true),
            'Average stabilised-year occupancy less break-even'],
          ['Interest-only', `${operating.interestOnlyMonths} mo`, 'Through stabilization'],
        ],
      },
      debtSizingNote(financing.sizing),
      {
        type: 'table',
        title: 'Exit',
        source: 'model.exit',
        headers: ['Line', 'Amount', 'Note'],
        align: ['l', 'r', 'l'],
        rows: [
          ['Forward 12-month NOI', money0(exit.forwardNoi), 'Priced on forward NOI, not year-one'],
          ['Gross sale price', money0(exit.grossSalePrice), `Forward NOI ÷ ${pctRaw(deal.exitCapRate)}`],
          ['Cost of sale', `(${money0(exit.costOfSale).replace('$', '$')})`, 'Brokerage and closing'],
          ['Loan payoff', `(${money0(exit.loanPayoff)})`, 'Outstanding balance at sale'],
        ],
        total: ['Net sale proceeds', money0(exit.netSaleProceeds), ''],
      },
    ],
  });

  // 3 — Cash flow ----------------------------------------------------------
  pages.push({
    n: 3,
    title: 'Cash Flow Summary',
    blocks: [
      {
        type: 'table',
        title: 'Annual cash flow ($000s)',
        source: 'model.annual',
        headers: ['Year', 'EGI', 'Recoveries', 'OpEx', 'Tax', 'NOI', 'Debt service', 'Cash flow'],
        align: ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
        rows: model.annual.map((y) => [
          `Y${y.year}${y.partial ? ` (${y.months}mo)` : ''}`,
          acct(y.egi / 1000), acct(y.recoveries / 1000), acct(-y.opex / 1000),
          acct(-y.tax / 1000), acct(y.noi / 1000), acct(-y.debtService / 1000), acct(y.cashFlow / 1000),
        ]),
      },
      {
        type: 'note',
        text: 'Figures in thousands; negatives in parentheses. Exit proceeds are excluded from the cash flow line and reported on the returns page. Operating expenses exclude property tax, which is computed separately from the market rate.',
      },
    ],
  });

  // 4 — Sensitivity --------------------------------------------------------
  const beCap = breakeven(deal, { variable: 'exitCapRate', metric: 'leveredIRR', target: 0.18 });
  const beDscr = breakeven(deal, { variable: 'interestRate', metric: 'minStabilizedDSCR', target: 1.25 });
  pages.push({
    n: 4,
    title: 'Sensitivity & Scenarios',
    blocks: [
      {
        type: 'table',
        title: 'Scenarios',
        source: 'sensitivity.runScenarios',
        headers: ['Measure', ...scenarios.map((s) => s.label)],
        align: ['l', 'r', 'r', 'r'],
        rows: [
          ['Levered IRR', ...scenarios.map((s) => pct(s.model.returns.leveredIRR))],
          ['Equity multiple', ...scenarios.map((s) => mult(s.model.returns.equityMultiple))],
          ['Yield on cost', ...scenarios.map((s) => pct(s.model.operating.yieldOnCost, 2))],
          ['Dev spread', ...scenarios.map((s) => s.model.operating.developmentSpreadBps === null ? NA : bps(s.model.operating.developmentSpreadBps))],
          ['DSCR stabilized', ...scenarios.map((s) => mult(s.model.operating.minStabilizedDSCR))],
          ['Profit', ...scenarios.map((s) => money(s.model.returns.profit))],
        ],
      },
      {
        type: 'matrix',
        title: 'Levered IRR — exit cap rate (columns) against interest rate (rows)',
        source: 'sensitivity.sensitivityGrid',
        xLabels: grid.xValues.map((v) => v.toFixed(2)),
        yLabels: grid.yValues.map((v) => v.toFixed(2)),
        rows: grid.rows.map((r) => r.map((v) => (v === null ? NA : pct(v)))),
        centre: [2, 2],
      },
      {
        type: 'table',
        title: 'Breakeven',
        source: 'sensitivity.breakeven',
        headers: ['Test', 'Value'],
        align: ['l', 'r'],
        rows: [
          ['Exit cap rate producing an 18.0% levered IRR', beCap === null ? NA : pctRaw(beCap, 2)],
          ['Interest rate at which stabilized DSCR reaches 1.25×', beDscr === null ? NA : pctRaw(beDscr, 2)],
        ],
      },
      {
        type: 'note',
        text: 'Scenario deltas: downside applies +75 bps exit cap, +100 bps rate, +10% hard cost and −8% revenue; upside applies −40 bps exit cap and +6% revenue. Every cell re-runs the full monthly model rather than perturbing a closed form.',
      },
    ],
  });

  // 5 — Market -------------------------------------------------------------
  pages.push({
    n: 5,
    title: 'Market Context',
    blocks: scored ? [
      {
        type: 'facts',
        items: [
          kv('Market', `${market.city}, ${market.state}`, 'markets'),
          kv('Opportunity score', `${scored.score.toFixed(0)} / 100`, 'marketScore.scoreMarket'),
          kv('Effective tax rate', pctRaw(market.effectiveTaxRate), 'markets.effectiveTaxRate'),
          kv('Population growth', pctRaw(market.popGrowth5y, 1), 'markets.popGrowth5y'),
          kv('Employment growth', pctRaw(market.employmentGrowth, 1), 'markets.employmentGrowth'),
          kv('Supply pipeline', pctRaw(market.supplyPipeline, 1), 'markets.supplyPipeline'),
        ],
      },
      {
        type: 'table',
        title: 'Score decomposition',
        source: 'marketScore.contributions',
        headers: ['Factor', 'Value', 'Percentile', 'Contribution'],
        align: ['l', 'r', 'r', 'r'],
        rows: scored.contributions.map((c) => [
          c.label,
          c.raw === null ? NA : num(c.raw, c.raw % 1 ? 2 : 0),
          c.percentile === null ? NA : `p${Math.round(c.percentile * 100)}`,
          `${c.contribution > 0 ? '+' : ''}${c.contribution.toFixed(1)}`,
        ]),
        total: ['Score', '', '', scored.score.toFixed(1)],
      },
      {
        type: 'note',
        text: `A score of 50 is the median across every factor within the peer market set. Contributions sum to the score. Weights are the ${scored.provenance.fitted ? 'firm-fitted model' : 'default prior, not yet fitted to realised outcomes'}; factor coverage is ${(scored.coverage * 100).toFixed(0)}%.`,
      },
    ] : [
      { type: 'note', text: `The market "${deal.location}" is not in the reference set, so no market context is available. Property tax has been applied at the default rate rather than a resolved market rate.` },
    ],
  });

  // 6 — Appendix -----------------------------------------------------------
  const assumptionRows = [
    ['Land / acquisition', money0(deal.purchasePrice), '—'],
    ['Hard cost', money0(deal.constructionCost), '—'],
    ['Contingency', pct(budget.contingencyRate, 1), '—'],
    ['Gross revenue (annual)', money0(deal.grossRevenue), '—'],
    governedRow('vacancyRate', deal),
    governedRow('operatingExpenseRatio', deal),
    ['Expense recovery', pct(model.assumptions.expenseRecoveryRate, 0), 'By property type'],
    ['Property tax rate', pctRaw(model.assumptions.propertyTaxRate), 'Resolved from market'],
    // On the constrained-sizing path runSizedToConstraints computes its own
    // equity share and never writes it back to the deal, so the stored input is
    // the discarded one. A column headed "Underwritten" must carry the figure
    // the model was underwritten at.
    sizedEquityRow(deal, model),
    governedRow('interestRate', deal),
    governedRow('loanTerm', deal),
    governedRow('exitCapRate', deal),
    ['Hold period', `${deal.holdPeriod} yrs`, '—'],
    ['Rent growth', pct(model.assumptions.rentGrowth, 1), FIELD_PRESENTATION.rentGrowth.fmt(firmDefault('rentGrowth', deal.propertyType))],
    ['Expense growth', pct(model.assumptions.expenseGrowth, 1), FIELD_PRESENTATION.expenseGrowth.fmt(firmDefault('expenseGrowth', deal.propertyType))],
    ['Cost of sale', pct(model.assumptions.costOfSalePct, 1), FIELD_PRESENTATION.costOfSalePct.fmt(firmDefault('costOfSalePct', deal.propertyType))],
  ];

  pages.push({
    n: 6,
    title: 'Appendix — Assumptions & Disclosures',
    blocks: [
      {
        type: 'table',
        title: `Assumption set — firm defaults ${FIRM_DEFAULTS.version}`,
        source: 'deal + firmDefaults',
        headers: ['Assumption', 'Underwritten', 'Firm default'],
        align: ['l', 'r', 'r'],
        rows: assumptionRows,
      },
      ov.length ? {
        type: 'note',
        title: 'Departures from the firm assumption set',
        text: ov.map((o) => {
          const fmt = FIELD_PRESENTATION[o.field]?.fmt ?? ((v) => num(v, v % 1 ? 2 : 0));
          return `${fieldLabel(o.field)} is underwritten at ${fmt(o.value)} against a firm default of ${fmt(o.firmValue)}.`;
        }).join(' '),
      } : { type: 'note', title: 'Departures from the firm assumption set', text: 'None. Every governed assumption is at its firm default.' },
      {
        type: 'flags',
        title: 'Validation',
        flags: flags.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail })),
      },
      {
        type: 'disclosure',
        title: 'Basis of preparation and limitations',
        items: [
          'Every figure in this memorandum is computed from a monthly discrete-period model at the time of generation. No figure is transcribed by hand.',
          'Returns are internal rates of return solved from dated monthly cash flows. Sale proceeds are net of cost of sale and the outstanding loan balance. The exit is priced on forward twelve-month net operating income.',
          'The operating expense ratio excludes property tax, which is computed separately from the market rate. Expense reimbursements are modelled from the property type rather than from lease-level terms.',
          // This sentence used to assert flatly that the model carried no
          // waterfall. It now does, so the standing claim would be false on
          // every memo built with a structure — and still needs saying on the
          // ones built without one, where the returns really are pre-promote.
          wfApplied
            ? 'The model has no rent roll and no tenant-level rollover. A joint-venture waterfall is applied on the returns page: the LP and GP figures there are after pref, return of capital and promote, and every other equity return in this memorandum is a project-level figure before promote.'
            : 'The model has no rent roll and no tenant-level rollover. No joint-venture waterfall or promote structure has been applied to this deal, so every equity return in this memorandum is a project-level figure shown before any promote.',
          'MARKET DATA: property tax rates aside, the market factors on the Market Context page are directional seed values. They are not sourced, not current, and must not be relied upon for an investment decision until replaced with a sourced feed.',
          'The screening result is a mechanical test against stated thresholds. It is not an investment recommendation, a valuation, or an appraisal.',
        ],
      },
    ].filter(Boolean),
  });

  return {
    meta: {
      title: 'Investment Committee Memorandum',
      dealName: deal.name,
      location: deal.location,
      stage: deal.stage ?? 'Screening',
      preparedBy,
      firm,
      date: date instanceof Date ? date : new Date(date),
      confidential: true,
      pageCount: pages.length,
    },
    pages,
    screen,
    provenance: {
      generatedAt: new Date().toISOString(),
      assumptionSet: FIRM_DEFAULTS.version,
      marketDataQuality: market?.provenance?.dataQuality ?? 'unresolved',
      modelFigureCount: countFigures(pages),
      overrides: ov.length,
      flags: flags.length,
    },
  };
}

function countFigures(pages) {
  let n = 0;
  for (const p of pages) {
    for (const b of p.blocks) {
      if (b.type === 'facts' || b.type === 'headline') n += b.items.length;
      if (b.type === 'table') n += b.rows.length * (b.headers.length - 1);
      if (b.type === 'matrix') n += b.rows.length * b.rows[0].length;
    }
  }
  return n;
}

export const SECTIONS = [
  'Investment Summary', 'Returns & Capitalisation', 'Cash Flow Summary',
  'Sensitivity & Scenarios', 'Market Context', 'Appendix — Assumptions & Disclosures',
];
