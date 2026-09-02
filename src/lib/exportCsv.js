import { propertyTypes, constructionTypes } from './propertyTypes';

const round = (n, dp = 0) =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(dp));

/**
 * Percent columns are derived from the RATIO on model.operating and scaled
 * exactly once here.
 *
 * calculateMetrics() percent-scales some of the same figures for the flat
 * metric bag the UI reads, so the same quantity exists in two conventions —
 * `metrics.goingInCapRate` is 6.85 while `model.operating.goingInCapRate` is
 * 0.0685. Taking every percent column from one side and scaling it in one
 * place is what keeps a column from shipping at 685% or at 0.07%.
 */
const ratioPct = (r, dp = 2) =>
  r === null || r === undefined || !Number.isFinite(r) ? null : Number((r * 100).toFixed(dp));

/**
 * `operating` off the deal's model, or an empty bag.
 *
 * A deal whose metrics have not been computed yet must export as 'n/a', not
 * crash the export of every other row in the pipeline.
 */
const op = (d) => d.metrics?.model?.operating ?? {};

/** The lender test that sized the loan, or the fact that none did. */
const CONSTRAINT_LABEL = {
  ltc: 'Loan to cost',
  dscr: 'Debt service coverage',
  debtYield: 'Debt yield',
};

/**
 * Column names state the metric actually computed. The original export
 * labelled a CAGR-on-total-return figure as "IRR".
 */
export const COLUMNS = [
  ['Deal Name',                d => d.name],
  ['Stage',                    d => d.stage ?? ''],
  ['Owner',                    d => d.owner ?? ''],
  ['Property Type',            d => propertyTypes[d.propertyType]?.name ?? d.propertyType],
  ['Construction Type',        d => constructionTypes[d.constructionType]?.name ?? d.constructionType],
  ['Location',                 d => d.location],
  ['Total Development Cost ($)', d => round(d.metrics?.totalProjectCost)],
  ['Capitalized Interest ($)', d => round(d.metrics?.capitalizedInterest)],
  ['Equity Commitment ($)',    d => round(d.metrics?.downPaymentAmount)],
  ['Peak Equity ($)',          d => round(d.metrics?.peakEquity)],
  ['Stabilized NOI ($)',       d => round(d.metrics?.noi)],
  // Yield on cost and going-in cap rate are separate columns under separate
  // names because they are separate numbers: one prices stabilized income
  // against everything spent to get there, the other prices the income already
  // in place against what was paid for it. A ground-up deal has no in-place
  // income, so the going-in column is 'n/a' there rather than a copy of the
  // yield-on-cost cell.
  ['Yield on Cost (%)',        d => round(d.metrics?.yieldOnCost, 2)],
  // Struck net of property tax, capital reserves and occupancy-scaled
  // recoveries — the institutional definition, and the one stabilised NOI in
  // this row uses. The model's own RENOVATION-period schedule credits in-place
  // income net of opex alone, so it runs up to 312 bps richer than this column,
  // and it is that schedule which feeds the IRR, Profit and Equity Multiple
  // cells beside it. The header says which definition this is so the two are
  // not read as one number.
  ['Going-In Cap Rate, net of tax & reserves (%)', d => ratioPct(op(d).goingInCapRate)],
  ['Going-In NOI, net of tax & reserves ($)',      d => round(op(d).goingInNOI)],
  ['Acquisition Basis ($)',    d => round(op(d).acquisitionBasis)],
  ['Exit Cap Rate (%)',        d => d.exitCapRate],
  ['Development Spread (bps)', d => round(d.metrics?.developmentSpreadBps)],
  // The occupancy at which the asset stops paying its own bills, and the
  // cushion between that and the occupancy underwritten. Named for what it
  // measures: it is not a vacancy assumption and it is not a return.
  ['Break-even Occupancy (%)', d => ratioPct(op(d).breakEvenOccupancy, 1)],
  // Named for what the engine computes: the MEAN occupancy across the
  // twelve-month stabilisation window, which finance.js records can still be
  // leasing up on a short hold. "Stabilized Occupancy" read as the vacancy
  // assumption, which is a different number and on a one-year hold a different
  // sign of cushion.
  ['Stabilized-Year Avg Occupancy (%)', d => ratioPct(op(d).stabilizedOccupancy, 1)],
  ['Stabilized DSCR',          d => round(d.metrics?.dscr, 2)],
  ['Min DSCR (stabilized)',    d => round(d.metrics?.minStabilizedDSCR, 2)],
  ['Min DSCR (incl. lease-up)',d => round(d.metrics?.minDSCR, 2)],
  ['Debt Yield (%)',           d => round(d.metrics?.debtYield, 2)],
  // A loan sized to a covenant and a loan sized to an equity percentage are
  // different claims about the same dollar figure, and the balance column
  // reads identically either way. These two say which one it is.
  ['Debt Sizing Basis',        d => {
    const financing = d.metrics?.model?.financing;
    if (!financing) return null;
    // What the deal ASKED for and what the engine could DO are separate facts,
    // and the sizing object alone reports neither cleanly. A credit-box deal
    // whose model never reached a schedule carried no sizing at all and
    // exported as "Equity share input"; one where no lender test could be
    // evaluated carried a sizing with a null loan and exported as "Lender
    // constraint (unconverged)" — a constraint that was never applied.
    const asked = Boolean(d.sizeDebtToConstraints);
    if (!financing.sizing) {
      return asked ? 'Lender constraint requested, not applied' : 'Equity share input';
    }
    if (financing.sizing.loanAmount === null) return 'Lender constraint requested, no test evaluable';
    // Sizing is a fixed point — the loan capitalises interest, which moves
    // basis, which moves the loan. An unsettled loop reports its last iterate,
    // and a balance that is one pass short of its own constraint should not
    // export looking like a solved one.
    return financing.sizing.converged ? 'Lender constraint' : 'Lender constraint (unconverged)';
  }],
  ['Binding Debt Constraint',  d => {
    const s = d.metrics?.model?.financing?.sizing;
    if (!s) return null;
    return CONSTRAINT_LABEL[s.bindingConstraint] ?? null;
  }],
  ['Gross Sale Price ($)',     d => round(d.metrics?.exitValue)],
  ['Net Sale Proceeds ($)',    d => round(d.metrics?.netSaleProceeds)],
  ['Levered IRR (%)',          d => round(d.metrics?.leveredIRR, 2)],
  ['Unlevered IRR (%)',        d => round(d.metrics?.unleveredIRR, 2)],
  ['Equity Multiple (x)',      d => round(d.metrics?.equityMultiple, 2)],
  ['Profit ($)',               d => round(d.metrics?.profit)],
  ['Construction Months',      d => d.metrics?.constructionTimeframe],
];

export function toCSV(deals) {
  const escape = (cell) => '"' + String(cell).replace(/"/g, '""') + '"';
  const rows = deals.map((d) => COLUMNS.map(([, get]) => {
    const v = get(d);
    return v === null || v === undefined ? 'n/a' : v;
  }));
  return [COLUMNS.map(([label]) => label), ...rows]
    .map((row) => row.map(escape).join(','))
    .join('\r\n');
}

export function exportDealsCSV(deals, filename = 'cre-deal-analysis.csv') {
  // Prefixed with a BOM so Excel reads it as UTF-8.
  const blob = new Blob(['﻿' + toCSV(deals)], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}
