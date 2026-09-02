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

const kv = (label, value, source) => ({ label, value, source });

/**
 * Build the memo.
 * @returns {{meta:Object, pages:Array, provenance:Object}}
 */
export function buildMemo(deal, {
  preparedBy = deal.owner ?? 'Unattributed',
  firm = 'Investment Committee',
  date = new Date(),
  covenants = {},
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
        type: 'table',
        title: 'Operating & credit',
        source: 'model.operating',
        headers: ['Measure', 'Value', 'Test'],
        align: ['l', 'r', 'l'],
        rows: [
          ['Stabilized NOI', money0(operating.stabilizedNOI), `Stabilizes month ${operating.stabilizationMonth}`],
          ['Yield on cost', pct(operating.yieldOnCost, 2), 'Stabilized NOI ÷ total development cost'],
          ['Exit cap rate', pctRaw(deal.exitCapRate), 'Underwritten'],
          ['Development spread', operating.developmentSpreadBps === null ? NA : bps(operating.developmentSpreadBps), 'Yield on cost less exit cap'],
          ['DSCR, stabilized', mult(operating.minStabilizedDSCR), 'Minimum rolling year from stabilization'],
          ['DSCR, incl. lease-up', mult(operating.minDSCR), 'Minimum rolling year over the full hold'],
          ['Debt yield', pct(operating.debtYield, 2), 'Stabilized NOI ÷ loan balance'],
          ['Loan to cost', pct(financing.ltc, 1), 'Permanent balance ÷ total project cost'],
          ['Interest-only', `${operating.interestOnlyMonths} mo`, 'Through stabilization'],
        ],
      },
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
    governedRow('downPayment', deal),
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
          'The model has no rent roll and no tenant-level rollover. It carries no joint-venture waterfall or promote structure; equity returns are shown before any promote.',
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
