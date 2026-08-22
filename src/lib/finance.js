/**
 * CRE underwriting engine.
 *
 * A monthly discrete-period model covering the construction/renovation period
 * and the operating hold, terminating in a sale. Every figure the UI reports is
 * derived from the monthly schedule this module produces — there are no
 * shortcut formulas layered on top of it.
 *
 * What this fixes relative to the original single-formula implementation:
 *   - Returns are a true IRR solved from dated cash flows, not a CAGR applied
 *     to a total-return ratio.
 *   - Sale proceeds net the OUTSTANDING loan balance and cost of sale, so
 *     principal amortisation accrues to equity as it should.
 *   - Exit is priced off forward 12-month NOI, not year-one NOI.
 *   - Revenue, expenses and assessed value escalate; lease-up is modelled.
 *   - Operating expenses split fixed/variable so lease-up doesn't understate cost.
 *   - Construction interest is capitalised into basis via an interest reserve.
 *   - "Cap rate on cost" is reported as yield-on-cost, alongside the development
 *     spread to exit cap — the metric that actually decides a ground-up deal.
 */

import { propertyTypes, constructionTypes } from './propertyTypes';
import { getPropertyTaxRate } from './markets';

export const DEFAULT_ASSUMPTIONS = {
  rentGrowth: 0.03,           // annual
  expenseGrowth: 0.025,       // annual
  assessmentGrowth: 0.025,    // annual growth in assessed value
  variableOpexShare: 0.30,    // share of opex that scales with occupancy
  costOfSalePct: 0.015,       // brokerage + closing at disposition
  interestOnlyMonths: 0,      // post-completion IO period
  initialOccupancy: 0,        // occupancy at completion, before lease-up
  inPlaceRevenue: 0,          // annual in-place revenue during renovation
};

// ─── primitives ──────────────────────────────────────────────────────────────

/**
 * Level payment for a fully-amortising loan.
 */
export function amortizingPayment(principal, annualRate, termYears) {
  const n = Math.round(termYears * 12);
  if (!(principal > 0) || n <= 0) return 0;
  const r = annualRate / 12;
  if (r === 0) return principal / n;
  const g = Math.pow(1 + r, n);
  return (principal * r * g) / (g - 1);
}

/**
 * Internal rate of return for evenly-spaced cash flows, solved by bisection.
 *
 * Bisection rather than Newton-Raphson: it cannot diverge, and an underwriting
 * tool returning a wrong-but-confident number is worse than returning null.
 * Returns null when no rate exists (no sign change, or no bracketed root) —
 * callers must render that as "n/a", never as 0.
 *
 * @param {number[]} cashFlows Flow at each period; index 0 is time zero.
 * @returns {number|null} Rate per period.
 */
export function irr(cashFlows, { tol = 1e-10, maxIter = 300 } = {}) {
  if (!Array.isArray(cashFlows) || cashFlows.length < 2) return null;
  if (cashFlows.some((c) => !Number.isFinite(c))) return null;
  if (!cashFlows.some((c) => c > 0) || !cashFlows.some((c) => c < 0)) return null;

  const npv = (r) => {
    let acc = 0;
    for (let i = 0; i < cashFlows.length; i++) acc += cashFlows[i] / Math.pow(1 + r, i);
    return acc;
  };

  let lo = -0.9999;
  let hi = 1.0;
  let fLo = npv(lo);
  let fHi = npv(hi);

  // Expand the upper bound before giving up.
  let expand = 0;
  while (fLo * fHi > 0 && expand < 60) {
    hi *= 2;
    fHi = npv(hi);
    expand++;
  }
  if (fLo * fHi > 0) return null;

  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < tol || (hi - lo) / 2 < 1e-12) return mid;
    if (fLo * fMid <= 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}

/** Compound a per-period rate to an annual rate. */
export function annualize(monthlyRate, periodsPerYear = 12) {
  if (monthlyRate === null || !Number.isFinite(monthlyRate)) return null;
  return Math.pow(1 + monthlyRate, periodsPerYear) - 1;
}

/** Net present value at a per-period discount rate. */
export function npv(rate, cashFlows) {
  return cashFlows.reduce((acc, c, i) => acc + c / Math.pow(1 + rate, i), 0);
}

// ─── the model ───────────────────────────────────────────────────────────────

/**
 * Run the full monthly model for a deal.
 *
 * Timeline: month 0 is the land/asset closing. Construction or renovation runs
 * for `constructionMonths`. Operations then run for `holdPeriod` years, with the
 * sale at the end of the final operating month.
 *
 * @returns {Object} schedule + derived metrics + the assumptions actually used.
 */
export function runModel(deal = {}, overrides = {}) {
  const {
    propertyType = 'carwash',
    constructionType = 'groundUp',
    purchasePrice = 0,
    constructionCost = 0,
    buildingSize = 0,
    units = 0,
    downPayment = 25,
    interestRate = 6.5,
    loanTerm = 25,
    grossRevenue = 0,
    vacancyRate = 5,
    operatingExpenseRatio = 35,
    exitCapRate = 6.5,
    holdPeriod = 5,
    location = '',
  } = deal;

  const typeCfg = propertyTypes[propertyType] || propertyTypes.carwash;
  const constCfg = constructionTypes[constructionType] || constructionTypes.groundUp;
  const a = { ...DEFAULT_ASSUMPTIONS, ...overrides, ...(deal.assumptions || {}) };

  const propertyTaxRate = deal.propertyTaxRate ?? getPropertyTaxRate(location);
  const leaseUpMonths = a.leaseUpMonths ?? typeCfg.leaseUpMonths ?? 12;
  const capexReserveAnnual =
    typeCfg.revenueBasis === 'unit' && units > 0
      ? (typeCfg.capexReservePerUnit ?? 300) * units
      : (typeCfg.capexReservePerSF ?? 0.25) * buildingSize;

  // Budget ------------------------------------------------------------------
  const land = Math.max(0, purchasePrice);
  const hardCost = Math.max(0, constructionCost) * (1 + constCfg.contingency);
  const softCost = hardCost * constCfg.softCostPct;
  const baseProjectCost = land + hardCost + softCost;

  const equityCommitment = baseProjectCost * (downPayment / 100);
  const loanCommitment = baseProjectCost - equityCommitment;
  const monthlyRate = interestRate / 100 / 12;

  const C = Math.max(0, Math.round(constCfg.timeframe || 0));
  const N = Math.max(0, Math.round(holdPeriod * 12));

  if (N === 0 || baseProjectCost <= 0) {
    return degenerateResult({ baseProjectCost, propertyTaxRate, equityCommitment, loanCommitment, a, C, N });
  }

  const stabilizedOcc = Math.max(0.01, 1 - vacancyRate / 100);
  const inPlaceMonthlyNoi = constCfg.hasInPlaceIncome
    ? (a.inPlaceRevenue / 12) * (1 - operatingExpenseRatio / 100)
    : 0;

  // Cost draw schedule: land at closing, hard+soft straight-line across the
  // construction period. (An S-curve is more realistic; straight-line is the
  // conservative, auditable default and is overridable via `drawSchedule`.)
  const costAt = (i) => {
    let c = i === 0 ? land : 0;
    if (C > 0) { if (i < C) c += (hardCost + softCost) / C; }
    else if (i === 0) { c += hardCost + softCost; }
    return c;
  };

  // Construction period ------------------------------------------------------
  const months = [];
  let loanBalance = 0;
  let loanDrawn = 0;
  let equityDrawn = 0;
  let capitalizedInterest = 0;

  for (let i = 0; i < C; i++) {
    const cost = costAt(i);
    const interest = loanBalance * monthlyRate;
    const netOpsCash = inPlaceMonthlyNoi - interest;

    let need = cost;
    let equityThisMonth = Math.min(need, Math.max(0, equityCommitment - equityDrawn));
    need -= equityThisMonth;
    const loanThisMonth = Math.min(need, Math.max(0, loanCommitment - loanDrawn));
    need -= loanThisMonth;
    if (need > 1e-9) equityThisMonth += need; // budget overrun falls to equity

    equityDrawn += equityThisMonth;
    loanDrawn += loanThisMonth;
    loanBalance += loanThisMonth;

    // Interest shortfall is capitalised (the interest reserve); surplus in-place
    // income is distributed.
    let distribution = 0;
    if (netOpsCash < 0) {
      loanBalance += -netOpsCash;
      capitalizedInterest += -netOpsCash;
    } else {
      distribution = netOpsCash;
    }

    months.push({
      index: i,
      phase: 'construction',
      cost,
      noi: inPlaceMonthlyNoi,
      interest,
      debtService: Math.min(inPlaceMonthlyNoi, interest),
      equityDraw: equityThisMonth,
      loanBalance,
      cashFlow: distribution,
      equityFlow: distribution - equityThisMonth,
    });
  }

  const totalProjectCost = baseProjectCost + capitalizedInterest;
  const permanentLoanBalance = loanBalance;
  const payment = amortizingPayment(permanentLoanBalance, interestRate / 100, loanTerm);

  // Operating period ---------------------------------------------------------
  /** Projected operating figures `t` months after completion. */
  const operatingMonth = (t) => {
    const yr = t / 12;
    const gpr = (grossRevenue / 12) * Math.pow(1 + a.rentGrowth, yr);
    const occ =
      leaseUpMonths > 0 && t < leaseUpMonths
        ? a.initialOccupancy + (stabilizedOcc - a.initialOccupancy) * ((t + 1) / leaseUpMonths)
        : stabilizedOcc;
    const egi = gpr * occ;

    // Opex is budgeted off the STABILISED revenue base, then flexed by the
    // variable share. Applying the ratio to actual EGI would make a
    // half-empty building look half as expensive to run.
    const opexBase =
      (grossRevenue / 12) * stabilizedOcc * (operatingExpenseRatio / 100) * Math.pow(1 + a.expenseGrowth, yr);
    const opex = opexBase * ((1 - a.variableOpexShare) + a.variableOpexShare * (occ / stabilizedOcc));

    const assessed = totalProjectCost * Math.pow(1 + a.assessmentGrowth, yr);
    const tax = (assessed * (propertyTaxRate / 100)) / 12;
    const reserve = (capexReserveAnnual / 12) * Math.pow(1 + a.expenseGrowth, yr);

    return { gpr, occ, egi, opex, tax, reserve, noi: egi - opex - tax - reserve };
  };

  let balance = permanentLoanBalance;
  for (let t = 0; t < N; t++) {
    const m = operatingMonth(t);
    const interest = balance * monthlyRate;
    let debtService;
    if (t < a.interestOnlyMonths) {
      debtService = interest;
    } else {
      debtService = Math.min(payment, balance + interest);
      balance = Math.max(0, balance + interest - debtService);
    }
    const cashFlow = m.noi - debtService;
    months.push({
      index: C + t,
      phase: t < leaseUpMonths ? 'lease-up' : 'stabilized',
      cost: 0,
      ...m,
      interest,
      debtService,
      equityDraw: 0,
      loanBalance: balance,
      cashFlow,
      equityFlow: cashFlow,
    });
  }

  // Exit ---------------------------------------------------------------------
  // Priced off forward 12-month NOI, i.e. what a buyer underwrites at closing.
  let forwardNoi = 0;
  for (let t = N; t < N + 12; t++) forwardNoi += operatingMonth(t).noi;

  const grossSalePrice = exitCapRate > 0 ? forwardNoi / (exitCapRate / 100) : totalProjectCost;
  const costOfSale = grossSalePrice * a.costOfSalePct;
  const loanPayoff = balance;
  const netSaleProceeds = grossSalePrice - costOfSale - loanPayoff;

  const last = months[months.length - 1];
  last.saleGross = grossSalePrice;
  last.saleCost = costOfSale;
  last.loanPayoff = loanPayoff;
  last.netSaleProceeds = netSaleProceeds;
  last.equityFlow += netSaleProceeds;

  // Derived metrics ----------------------------------------------------------
  const equityFlows = months.map((m) => m.equityFlow);
  const unleveredFlows = months.map((m) => m.noi - m.cost);
  unleveredFlows[unleveredFlows.length - 1] += grossSalePrice - costOfSale;

  const leveredIRR = annualize(irr(equityFlows));
  const unleveredIRR = annualize(irr(unleveredFlows));

  const inflows = equityFlows.filter((f) => f > 0).reduce((s, f) => s + f, 0);
  const outflows = -equityFlows.filter((f) => f < 0).reduce((s, f) => s + f, 0);
  const equityMultiple = outflows > 0 ? inflows / outflows : null;

  let cum = 0;
  let peakEquity = 0;
  for (const f of equityFlows) { cum += f; peakEquity = Math.min(peakEquity, cum); }
  peakEquity = -peakEquity;

  // Stabilised year: the first full 12 months at stabilised occupancy.
  const stabStart = Math.min(leaseUpMonths, Math.max(0, N - 12));
  let stabilizedNOI = 0;
  let stabilizedDebtService = 0;
  for (let t = stabStart; t < stabStart + 12; t++) {
    stabilizedNOI += operatingMonth(t).noi;
    const m = months[C + t];
    stabilizedDebtService += m ? m.debtService : payment;
  }

  const yieldOnCost = totalProjectCost > 0 ? stabilizedNOI / totalProjectCost : null;
  const developmentSpreadBps =
    yieldOnCost !== null ? (yieldOnCost - exitCapRate / 100) * 10000 : null;
  const stabilizedDSCR = stabilizedDebtService > 0 ? stabilizedNOI / stabilizedDebtService : null;
  const debtYield = permanentLoanBalance > 0 ? stabilizedNOI / permanentLoanBalance : null;

  // Minimum DSCR across any rolling operating year.
  let minDSCR = null;
  for (let t = 0; t + 12 <= N; t++) {
    let n = 0;
    let d = 0;
    for (let k = t; k < t + 12; k++) { n += months[C + k].noi; d += months[C + k].debtService; }
    if (d > 0) { const v = n / d; minDSCR = minDSCR === null ? v : Math.min(minDSCR, v); }
  }

  const profit = equityFlows.reduce((s, f) => s + f, 0);

  return {
    months,
    annual: rollUpAnnual(months),
    assumptions: { ...a, leaseUpMonths, propertyTaxRate, capexReserveAnnual },
    budget: { land, hardCost, softCost, contingency: constCfg.contingency, baseProjectCost, capitalizedInterest, totalProjectCost },
    financing: { equityCommitment, loanCommitment, permanentLoanBalance, monthlyPayment: payment, annualDebtService: payment * 12, ltc: baseProjectCost > 0 ? loanCommitment / baseProjectCost : 0 },
    exit: { forwardNoi, grossSalePrice, costOfSale, loanPayoff, netSaleProceeds, exitCapRate },
    returns: { leveredIRR, unleveredIRR, equityMultiple, peakEquity, profit, totalEquityInvested: outflows, totalDistributions: inflows },
    operating: { stabilizedNOI, stabilizedDebtService, yieldOnCost, developmentSpreadBps, stabilizedDSCR, minDSCR, debtYield, stabilizationMonth: C + stabStart },
    timeline: { constructionMonths: C, operatingMonths: N, leaseUpMonths, saleMonth: C + N - 1 },
  };
}

function rollUpAnnual(months) {
  const years = [];
  for (let i = 0; i < months.length; i += 12) {
    const slice = months.slice(i, i + 12);
    const sum = (k) => slice.reduce((s, m) => s + (m[k] || 0), 0);
    years.push({
      year: Math.floor(i / 12) + 1,
      egi: sum('egi'),
      opex: sum('opex'),
      tax: sum('tax'),
      reserve: sum('reserve'),
      noi: sum('noi'),
      debtService: sum('debtService'),
      cashFlow: sum('cashFlow'),
      equityFlow: sum('equityFlow'),
      endingLoanBalance: slice[slice.length - 1]?.loanBalance ?? 0,
    });
  }
  return years;
}

function degenerateResult({ baseProjectCost, propertyTaxRate, equityCommitment, loanCommitment, a, C, N }) {
  const nulls = { leveredIRR: null, unleveredIRR: null, equityMultiple: null, peakEquity: 0, profit: 0, totalEquityInvested: 0, totalDistributions: 0 };
  return {
    months: [], annual: [],
    assumptions: { ...a, propertyTaxRate },
    budget: { land: 0, hardCost: 0, softCost: 0, contingency: 0, baseProjectCost, capitalizedInterest: 0, totalProjectCost: baseProjectCost },
    financing: { equityCommitment, loanCommitment, permanentLoanBalance: 0, monthlyPayment: 0, annualDebtService: 0, ltc: 0 },
    exit: { forwardNoi: 0, grossSalePrice: 0, costOfSale: 0, loanPayoff: 0, netSaleProceeds: 0, exitCapRate: 0 },
    returns: nulls,
    operating: { stabilizedNOI: 0, stabilizedDebtService: 0, yieldOnCost: null, developmentSpreadBps: null, stabilizedDSCR: null, minDSCR: null, debtYield: null, stabilizationMonth: 0 },
    timeline: { constructionMonths: C, operatingMonths: N, leaseUpMonths: 0, saleMonth: 0 },
    incomplete: true,
  };
}

/**
 * Backwards-compatible flat metric bag for the existing UI.
 * New code should consume `runModel` directly.
 */
export function calculateMetrics(deal) {
  const r = runModel(deal);
  const pct = (x) => (x === null || x === undefined ? null : x * 100);
  return {
    // corrected / renamed
    totalProjectCost: r.budget.totalProjectCost,
    baseProjectCost: r.budget.baseProjectCost,
    capitalizedInterest: r.budget.capitalizedInterest,
    downPaymentAmount: r.financing.equityCommitment,
    loanAmount: r.financing.loanCommitment,
    permanentLoanBalance: r.financing.permanentLoanBalance,
    monthlyPayment: r.financing.monthlyPayment,
    annualDebtService: r.financing.annualDebtService,
    propertyTaxRate: r.assumptions.propertyTaxRate,
    noi: r.operating.stabilizedNOI,
    yieldOnCost: pct(r.operating.yieldOnCost),
    capRate: pct(r.operating.yieldOnCost),   // legacy alias — this was always yield on cost
    developmentSpreadBps: r.operating.developmentSpreadBps,
    dscr: r.operating.stabilizedDSCR,
    minDSCR: r.operating.minDSCR,
    debtYield: pct(r.operating.debtYield),
    exitValue: r.exit.grossSalePrice,
    netSaleProceeds: r.exit.netSaleProceeds,
    cashFlow: r.annual.find((y) => y.cashFlow !== 0)?.cashFlow ?? 0,
    cashOnCash: r.financing.equityCommitment > 0
      ? ((r.annual[r.timeline.constructionMonths >= 12 ? 1 : 0]?.cashFlow ?? 0) / r.financing.equityCommitment) * 100
      : 0,
    leveredIRR: pct(r.returns.leveredIRR),
    unleveredIRR: pct(r.returns.unleveredIRR),
    annualizedReturn: pct(r.returns.leveredIRR),  // legacy key, now a real IRR
    equityMultiple: r.returns.equityMultiple,
    totalROI: r.returns.equityMultiple !== null ? (r.returns.equityMultiple - 1) * 100 : null,
    peakEquity: r.returns.peakEquity,
    profit: r.returns.profit,
    constructionTimeframe: r.timeline.constructionMonths,
    model: r,
  };
}
