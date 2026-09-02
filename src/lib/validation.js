/**
 * Covenant and sanity validation.
 *
 * Each rule names the assumption field it indicts, so the UI can attach the
 * warning to the offending input rather than dumping a list in a side panel.
 * Thresholds are firm-level policy and are passed in, not hardcoded — an
 * enterprise customer's credit box is theirs, not ours.
 */

import { DEFAULT_DEBT_SIZING } from './finance';

export const DEFAULT_COVENANTS = {
  // minDSCR, maxLTC and minDebtYield come from the sizing limits so that the
  // two cannot drift: a loan sized to the credit box must not then be flagged
  // against a different credit box.
  ...DEFAULT_DEBT_SIZING,
  minDevSpreadBps: 100,
  minYieldOnCostOverExit: 0,   // yield on cost must at least reach the exit cap
  maxBreakEvenOccupancy: 0.80,
  maxRentGrowth: 0.03,
};

const rule = (id, severity, field, title, detail) => ({ id, severity, field, title, detail });

// A metric sized exactly to a limit must not read as breaching it. The debt
// sizer lands its fixed point within a fraction of a dollar of the constraint,
// which leaves the covenant short by parts in a hundred million; a screen
// reporting "1.25x" beside "breaches 1.25x covenant" is unusable.
const AT_LIMIT = 1e-6;
const below = (value, limit) => value < limit - Math.abs(limit) * AT_LIMIT;
const above = (value, limit) => value > limit + Math.abs(limit) * AT_LIMIT;

/**
 * @param {Object} model  Result of runModel()
 * @param {Object} deal
 * @param {Object} covenants
 * @returns {Array<{id,severity,field,title,detail}>} ordered most severe first
 */
export function validate(model, deal = {}, covenants = {}) {
  const c = { ...DEFAULT_COVENANTS, ...covenants };
  const flags = [];
  if (!model || model.incomplete) {
    return [rule('incomplete', 'error', 'purchasePrice', 'Model incomplete',
      'Enter a project cost and a hold period to produce a cash flow.')];
  }

  const { operating, financing, returns, exit, budget, assumptions } = model;
  const bps = (x) => `${x >= 0 ? '+' : ''}${Math.round(x)} bps`;
  const pct = (x) => `${(x * 100).toFixed(2)}%`;

  // The covenant is tested at stabilization. Coverage during lease-up is a
  // separate question, answered by the interest reserve, and is reported as
  // its own flag rather than being conflated with a covenant breach.
  const covenantDSCR = operating.minStabilizedDSCR ?? operating.minDSCR;
  if (covenantDSCR !== null && below(covenantDSCR, c.minDSCR)) {
    flags.push(rule('dscr', 'error', 'interestRate',
      `Stabilized DSCR ${covenantDSCR.toFixed(2)}x breaches ${c.minDSCR.toFixed(2)}x covenant`,
      'Debt service exceeds what the property covers in at least one stabilized year. Reduce leverage, extend the interest-only period, or re-underwrite revenue.'));
  }

  if (operating.minDSCR !== null && operating.minDSCR < 1.0 &&
      (operating.minStabilizedDSCR === null || operating.minStabilizedDSCR >= c.minDSCR)) {
    flags.push(rule('leaseUpCoverage', 'info', 'grossRevenue',
      `Coverage dips to ${operating.minDSCR.toFixed(2)}x during lease-up`,
      `Expected while the asset leases up. Interest-only runs ${operating.interestOnlyMonths} months through stabilization; the shortfall is carried by the interest reserve.`));
  }

  if (operating.developmentSpreadBps !== null && operating.developmentSpreadBps < c.minDevSpreadBps) {
    const negative = operating.developmentSpreadBps < 0;
    flags.push(rule('spread', negative ? 'error' : 'warning', 'exitCapRate',
      `Development spread ${bps(operating.developmentSpreadBps)} is below the ${c.minDevSpreadBps} bps floor`,
      negative
        ? 'Yield on cost is below the exit cap: the asset is worth less than it costs to build. This deal does not pencil as a development.'
        : 'Thin margin for cost overrun or cap rate expansion between now and stabilization.'));
  }

  if (above(financing.ltc, c.maxLTC)) {
    flags.push(rule('ltc', 'warning', 'downPayment',
      `Loan-to-cost ${pct(financing.ltc)} exceeds the ${pct(c.maxLTC)} limit`,
      'Leverage is above the firm credit box. Most construction lenders will resize the loan.'));
  }

  if (operating.debtYield !== null && below(operating.debtYield, c.minDebtYield)) {
    flags.push(rule('debtYield', 'warning', 'downPayment',
      `Debt yield ${pct(operating.debtYield)} is below the ${pct(c.minDebtYield)} minimum`,
      'Lenders size to debt yield independently of DSCR. Expect a smaller loan than modelled.'));
  }

  // Break-even occupancy is the only figure here that answers "how empty can
  // this get before it stops paying its own bills", which no return metric does.
  const breakEven = operating.breakEvenOccupancy;
  const underwrittenOcc = operating.stabilizedOccupancy;
  // Two independent failures. Nesting the second inside the first is what
  // silenced this rule on the deals that needed it most: a break-even can sit
  // above the occupancy actually underwritten while still reading below the
  // firm's ceiling, and the ceiling test alone then never fires.
  const overCeiling = breakEven != null && breakEven > c.maxBreakEvenOccupancy;
  const noCushion = breakEven != null && underwrittenOcc != null && breakEven >= underwrittenOcc;
  if (overCeiling || noCushion) {
    // Break-even holds operating cost at its full-occupancy level, so it is an
    // upper bound and can sit above the underwritten occupancy on a deal whose
    // own stabilised coverage still clears 1.0x. The breach is only definite
    // once the schedule itself fails to cover debt service; short of that this
    // is a disclosure that the coverage depends on the expense budget shrinking
    // with the vacancy assumption, which is a warning, not a finding of fact.
    const uncovered = noCushion && operating.stabilizedDSCR !== null && operating.stabilizedDSCR < 1;
    const cushion = underwrittenOcc == null ? null : underwrittenOcc - breakEven;
    const title = noCushion
      ? `Break-even occupancy ${pct(breakEven)} is at or above the ${pct(underwrittenOcc)} underwritten`
      : `Break-even occupancy ${pct(breakEven)} exceeds the ${pct(c.maxBreakEvenOccupancy)} limit`;
    flags.push(rule('breakEvenOccupancy', uncovered ? 'error' : 'warning', 'vacancyRate', title,
      uncovered
        ? `Operating cost, tax, reserves and debt service are not covered at the ${pct(underwrittenOcc)} occupancy underwritten. The deal needs occupancy it does not assume.`
        : noCushion
          ? 'On a full-occupancy expense budget the asset does not clear its outgoings at the occupancy assumed. The margin here is the assumption that operating cost falls away with the tenants.'
          : `${cushion === null ? 'Little' : pct(cushion)} of occupancy separates this asset from negative cash flow. Reduce leverage or re-underwrite the expense load.`));
  }

  // Rent growth is the assumption that quietly does the work in a thin deal:
  // past this point the return is market appreciation, not the business plan.
  const { rentGrowth } = assumptions || {};
  // Strictly above, with a tolerance: an assumption sitting exactly on the
  // ceiling is compliant, and float noise in a derived override must not flag.
  if (Number.isFinite(rentGrowth) && rentGrowth > c.maxRentGrowth + 1e-9) {
    flags.push(rule('rentGrowth', 'warning', 'rentGrowth',
      `Rent growth ${pct(rentGrowth)}/yr exceeds the ${pct(c.maxRentGrowth)} ceiling`,
      'The underwriting is leaning on market appreciation rather than on the business plan. Re-run at the ceiling and check the return still clears.'));
  }

  const entryCap = deal.entryCapRate;
  if (typeof entryCap === 'number' && deal.exitCapRate < entryCap) {
    flags.push(rule('capCompression', 'warning', 'exitCapRate',
      `Exit cap ${deal.exitCapRate.toFixed(2)}% is tighter than the ${entryCap.toFixed(2)}% entry cap`,
      'The model assumes cap rate compression over the hold. Underwriting to expansion is the conservative convention.'));
  }

  if (returns.leveredIRR !== null && returns.unleveredIRR !== null &&
      returns.leveredIRR < returns.unleveredIRR) {
    flags.push(rule('negativeLeverage', 'warning', 'interestRate',
      'Negative leverage: the levered IRR is below the unlevered IRR',
      'The cost of debt exceeds the asset yield. Debt is destroying equity return at this rate.'));
  }

  if (budget.capitalizedInterest > budget.baseProjectCost * 0.10) {
    flags.push(rule('interestReserve', 'info', 'interestRate',
      `Interest reserve is ${pct(budget.capitalizedInterest / budget.totalProjectCost)} of total cost`,
      'A long construction period at this rate is capitalizing a large amount of interest into basis.'));
  }

  if (exit.netSaleProceeds < 0) {
    flags.push(rule('underwater', 'error', 'exitCapRate',
      'Sale proceeds do not repay the loan',
      'Gross sale price less cost of sale is below the outstanding balance at exit.'));
  }

  const order = { error: 0, warning: 1, info: 2 };
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function flagCounts(flags) {
  return flags.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }),
    { error: 0, warning: 0, info: 0 });
}
