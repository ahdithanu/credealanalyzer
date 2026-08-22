/**
 * Covenant and sanity validation.
 *
 * Each rule names the assumption field it indicts, so the UI can attach the
 * warning to the offending input rather than dumping a list in a side panel.
 * Thresholds are firm-level policy and are passed in, not hardcoded — an
 * enterprise customer's credit box is theirs, not ours.
 */

export const DEFAULT_COVENANTS = {
  minDSCR: 1.25,
  minDevSpreadBps: 100,
  maxLTC: 0.70,
  minDebtYield: 0.08,
  minYieldOnCostOverExit: 0,   // yield on cost must at least reach the exit cap
};

const rule = (id, severity, field, title, detail) => ({ id, severity, field, title, detail });

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

  const { operating, financing, returns, exit, budget } = model;
  const bps = (x) => `${x >= 0 ? '+' : ''}${Math.round(x)} bps`;
  const pct = (x) => `${(x * 100).toFixed(2)}%`;

  // The covenant is tested at stabilization. Coverage during lease-up is a
  // separate question, answered by the interest reserve, and is reported as
  // its own flag rather than being conflated with a covenant breach.
  const covenantDSCR = operating.minStabilizedDSCR ?? operating.minDSCR;
  if (covenantDSCR !== null && covenantDSCR < c.minDSCR) {
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

  if (financing.ltc > c.maxLTC) {
    flags.push(rule('ltc', 'warning', 'downPayment',
      `Loan-to-cost ${pct(financing.ltc)} exceeds the ${pct(c.maxLTC)} limit`,
      'Leverage is above the firm credit box. Most construction lenders will resize the loan.'));
  }

  if (operating.debtYield !== null && operating.debtYield < c.minDebtYield) {
    flags.push(rule('debtYield', 'warning', 'downPayment',
      `Debt yield ${pct(operating.debtYield)} is below the ${pct(c.minDebtYield)} minimum`,
      'Lenders size to debt yield independently of DSCR. Expect a smaller loan than modelled.'));
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
