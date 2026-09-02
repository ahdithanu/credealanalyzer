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
 *   - Going-in cap rate is reported separately from yield on cost, because they
 *     are different numbers and only one of them exists for a ground-up deal.
 *   - Break-even occupancy answers "how empty can this get before it stops
 *     paying its own bills", which no return metric answers.
 *   - Debt can be sized to the binding lender constraint instead of falling out
 *     of an equity-percentage input (opt in with `deal.sizeDebtToConstraints`).
 */

import { propertyTypes, constructionTypes } from './propertyTypes';
import { getPropertyTaxRate } from './markets';
import { firmDefault } from './firmDefaults';

export const DEFAULT_ASSUMPTIONS = {
  rentGrowth: 0.03,           // annual
  expenseGrowth: 0.025,       // annual
  assessmentGrowth: 0.025,    // annual growth in assessed value
  variableOpexShare: 0.30,    // share of opex that scales with occupancy
  costOfSalePct: 0.015,       // brokerage + closing at disposition
  interestOnlyMonths: null,   // post-completion IO period; null = through stabilization
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
 * KNOWN LIMIT: it returns the FIRST bracketed root and does not detect that
 * others exist. The model's own equity series has one sign change and therefore
 * one root, but a series that alternates sign more than once — a mid-life
 * capital call, or a sponsor funding co-invest across several draws and taking
 * promote at sale — can admit several, and this returns one of them with no
 * warning. Callers building such series (see waterfall.js) should treat a
 * single IRR on them as indicative.
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

  // Candidate lower bounds, deepest first. A rate close to -100% divides a late
  // flow by a vanishing number, and on a schedule of more than a few dozen
  // periods that overflows: flows of both signs then give +Infinity - Infinity,
  // which is NaN. NaN fails EVERY comparison, so a fixed lower bound of -0.9999
  // slipped past both `fLo * fHi > 0` guards below and bisection converged on a
  // bound that is not a root at all. On a 78-month deal that returned half its
  // equity it reported a monthly IRR of exactly 1.0 — a +409,500% annual return
  // beside a 0.50x multiple — on 52 of 396 sample parameter combinations. Only a
  // finite evaluation may serve as a bracket end.
  let lo = null;
  let fLo = null;
  for (const candidate of [-0.9999, -0.999, -0.99, -0.9, -0.5]) {
    const f = npv(candidate);
    if (Number.isFinite(f)) { lo = candidate; fLo = f; break; }
  }
  if (lo === null) return null;

  let hi = 1.0;
  let fHi = npv(hi);
  if (!Number.isFinite(fHi)) return null;

  // Expand the upper bound before giving up.
  let expand = 0;
  while (fLo * fHi > 0 && expand < 60) {
    hi *= 2;
    fHi = npv(hi);
    if (!Number.isFinite(fHi)) return null;
    expand++;
  }
  if (!(fLo * fHi <= 0)) return null;

  let root = null;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < tol || (hi - lo) / 2 < 1e-12) { root = mid; break; }
    if (fLo * fMid <= 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  if (root === null) root = (lo + hi) / 2;

  // The bracket says a root exists; this says the returned rate IS one. A
  // truncated loop, a bracket that straddles a pole rather than a zero, or an
  // arithmetic overflow anywhere in between all end here with an NPV nowhere
  // near zero, and a rate that does not zero the NPV is not an IRR. Measured
  // against the size of the flows, because "close to zero" on a $90m schedule
  // is not the same number of dollars as on a $900k one.
  const scale = cashFlows.reduce((s, c) => Math.max(s, Math.abs(c)), 0);
  const residual = npv(root);
  if (!Number.isFinite(residual) || Math.abs(residual) > Math.max(tol, scale * 1e-6)) return null;
  return root;
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

// ─── debt sizing ─────────────────────────────────────────────────────────────

/**
 * The lender's sizing tests.
 *
 * These are deliberately the same numbers as the credit covenants in
 * validation.js, which imports them from here: a loan sized against one set of
 * limits and then tested against another would be flagged the day it is drawn.
 */
export const DEFAULT_DEBT_SIZING = {
  maxLTC: 0.70,
  minDSCR: 1.25,
  minDebtYield: 0.08,
};

/**
 * Size a loan to the binding lender constraint.
 *
 * A lender runs all three tests and funds the smallest answer. The binding test
 * is returned with the amount because it is the more useful half: an
 * LTC-constrained deal is solved with more equity, a coverage-constrained deal
 * is not solved with equity at all, and the two call for different phone calls.
 *
 * A constraint that cannot be evaluated — no basis, no coverage floor, no
 * amortisation term — is returned as null rather than as zero or Infinity, so
 * an untested constraint can neither bind nor silently disappear from the
 * comparison. Zero appears only where it is a measured answer: NOI at or below
 * zero supports no debt, and a firm policy of no leverage is a limit of zero
 * rather than an absent test.
 *
 * Coverage is tested over every year the covenant governs, not just the first.
 * `coverage` carries those years as {noi, debtServicePerDollar} pairs, each
 * priced off the debt service the schedule actually charges in that year — an
 * interest-only year and an amortising year are different tests on the same
 * loan. Without it a deal whose NOI does not grow monotonically is sized to a
 * coverage it breaches in year two, and a loan drawn during interest-only is
 * sized against a payment the model never charges.
 *
 * @param {number} projectCost    Basis the LTC test is measured against.
 * @param {number} stabilizedNOI  Annual NOI at stabilization; sizes the debt yield.
 * @param {number} annualRate     Decimal, e.g. 0.065 — not percent.
 * @param {number} termYears      Amortisation term for the coverage test.
 * @param {Array}  [coverage]     Covenant years; defaults to one amortising stabilised year.
 * @returns {{loanAmount:number|null, bindingConstraint:('ltc'|'dscr'|'debtYield'|null), constraints:Object}}
 */
export function sizeDebt({
  projectCost,
  stabilizedNOI,
  annualRate,
  termYears,
  coverage,
  maxLTC = DEFAULT_DEBT_SIZING.maxLTC,
  minDSCR = DEFAULT_DEBT_SIZING.minDSCR,
  minDebtYield = DEFAULT_DEBT_SIZING.minDebtYield,
} = {}) {
  const noiKnown = Number.isFinite(stabilizedNOI);
  // Debt service is linear in principal, so one dollar of loan prices the test.
  const coverageYears = Array.isArray(coverage) && coverage.length > 0
    ? coverage
    : [{ noi: stabilizedNOI, debtServicePerDollar: amortizingPayment(1, annualRate, termYears) * 12 }];

  // The lender funds the smallest loan that clears coverage in EVERY year, so
  // the binding year is the worst one, not the first one.
  let dscrLimit = null;
  if (minDSCR > 0) {
    for (const year of coverageYears) {
      if (!Number.isFinite(year.noi) || !(year.debtServicePerDollar > 0)) continue;
      const limit = Math.max(0, year.noi / (minDSCR * year.debtServicePerDollar));
      if (dscrLimit === null || limit < dscrLimit) dscrLimit = limit;
    }
  }

  const constraints = {
    // A maxLTC of zero is a policy of no leverage — a measured limit of zero,
    // not an untestable constraint. Treating it as unevaluable drops the test
    // and funds whatever coverage allows.
    ltc: Number.isFinite(projectCost) && projectCost > 0 && Number.isFinite(maxLTC) && maxLTC >= 0
      ? projectCost * maxLTC
      : null,
    dscr: dscrLimit,
    debtYield: noiKnown && minDebtYield > 0 ? Math.max(0, stabilizedNOI / minDebtYield) : null,
  };

  // Fixed order, and a strict comparison, so that a tie always reports the same
  // binding test rather than flickering between two on rounding noise.
  let loanAmount = null;
  let bindingConstraint = null;
  for (const key of ['ltc', 'dscr', 'debtYield']) {
    const limit = constraints[key];
    if (limit === null) continue;
    if (loanAmount === null || limit < loanAmount) {
      loanAmount = limit;
      bindingConstraint = key;
    }
  }

  return { loanAmount, bindingConstraint, constraints };
}

// Sizing is a fixed point: the loan changes capitalised interest, which changes
// basis, which changes property tax and so NOI, which resizes the loan. The
// feedback is negative and small, so a handful of passes settles it; the result
// carries `converged` rather than pretending a truncated loop is exact.
const SIZING_MAX_PASSES = 8;
const SIZING_TOLERANCE = 1; // dollars

/**
 * Debt service per dollar of permanent balance, month by month, on the schedule
 * the model actually charges: interest-only first, then level amortisation.
 *
 * Every term is linear in principal — interest is balance x rate, the payment
 * scales with the loan — so a unit loan prices each coverage year exactly,
 * including the years still inside the interest-only period where the
 * amortising payment is not being paid at all.
 */
function unitDebtServiceSchedule({ operatingMonths, through, annualRate, termYears, interestOnlyMonths }) {
  const monthlyRate = annualRate / 12;
  const payment = amortizingPayment(1, annualRate, termYears);
  const schedule = [];
  let balance = 1;
  for (let t = 0; t < through; t++) {
    // Past the hold the schedule is only ever projected, and runModel's
    // stabilised window falls back to the full payment there; mirror it, so the
    // loan is sized to the same coverage the model goes on to report.
    if (t >= operatingMonths) { schedule.push(payment); continue; }
    const interest = balance * monthlyRate;
    if (t < interestOnlyMonths) { schedule.push(interest); continue; }
    const debtService = Math.min(payment, balance + interest);
    balance = Math.max(0, balance + interest - debtService);
    schedule.push(debtService);
  }
  return schedule;
}

/**
 * The twelve-month windows the DSCR covenant is tested over, priced per dollar
 * of permanent balance.
 *
 * Both windows validation.js can flag are included: the stabilised year, which
 * is what `operating.stabilizedDSCR` reports, and every complete rolling year
 * from stabilisation onward, which is what `minStabilizedDSCR` — the figure the
 * covenant is actually tested against — takes the minimum of. Sizing to the
 * first year alone puts a deal in breach the moment NOI stops growing
 * monotonically, which is any deal whose expense growth outruns its rent growth.
 */
function coverageWindows(model) {
  const C = model.timeline.constructionMonths;
  const N = model.timeline.operatingMonths;
  const stabStart = model.operating.stabilizationMonth - C;
  const unit = unitDebtServiceSchedule({
    operatingMonths: N,
    through: Math.max(N, stabStart + 12),
    annualRate: model.financing.interestRate / 100,
    termYears: model.financing.loanTerm,
    interestOnlyMonths: model.operating.interestOnlyMonths,
  });
  const perDollar = (from) => {
    let sum = 0;
    for (let k = from; k < from + 12; k++) sum += unit[k];
    return sum;
  };

  const windows = [{ noi: model.operating.stabilizedNOI, debtServicePerDollar: perDollar(stabStart) }];
  for (let t = stabStart; t + 12 <= N; t++) {
    let noi = 0;
    for (let k = t; k < t + 12; k++) noi += model.months[C + k].noi;
    windows.push({ noi, debtServicePerDollar: perDollar(t) });
  }
  return windows;
}

function runSizedToConstraints(deal, overrides) {
  const unsized = { ...deal, sizeDebtToConstraints: false };
  let model = runModel(unsized, overrides);
  if (model.incomplete) return model;

  const limits = { ...DEFAULT_DEBT_SIZING, ...(deal.debtSizing || {}) };
  const { baseProjectCost } = model.budget;
  let sizing = null;
  let converged = false;
  let passes = 0;

  while (passes < SIZING_MAX_PASSES) {
    passes++;
    sizing = sizeDebt({
      projectCost: model.budget.totalProjectCost,
      stabilizedNOI: model.operating.stabilizedNOI,
      coverage: coverageWindows(model),
      // Read back off the model rather than off the deal, so the resolved
      // defaults cannot drift from the terms the schedule was actually built on.
      annualRate: model.financing.interestRate / 100,
      termYears: model.financing.loanTerm,
      ...limits,
    });
    if (sizing.loanAmount === null) break;

    // The constraints are measured against the PERMANENT balance — commitment
    // plus the interest capitalised during construction — so the commitment
    // that gets funded is the target net of that reserve. Sizing the commitment
    // itself would fund a balance above every limit it was sized to.
    const commitment = Math.min(
      Math.max(sizing.loanAmount - model.budget.capitalizedInterest, 0),
      baseProjectCost,
    );
    const next = runModel({ ...unsized, downPayment: (1 - commitment / baseProjectCost) * 100 }, overrides);
    converged = Math.abs(next.financing.permanentLoanBalance - sizing.loanAmount) < SIZING_TOLERANCE;
    model = next;
    if (converged) break;
  }

  return { ...model, financing: { ...model.financing, sizing: { ...sizing, passes, converged } } };
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
  // Sizing needs a finished schedule to read stabilised NOI and basis off, so
  // it runs the model and re-runs it against the constrained loan. Opt-in: an
  // existing deal carries an equity percentage, and honouring that input is the
  // documented behaviour everything else in the app is built on.
  if (deal.sizeDebtToConstraints) return runSizedToConstraints(deal, overrides);

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
    exitCapRate = 6.5,
    holdPeriod = 5,
    location = '',
  } = deal;

  const typeCfg = propertyTypes[propertyType] || propertyTypes.carwash;
  const constCfg = constructionTypes[constructionType] || constructionTypes.groundUp;
  // Vacancy and the expense ratio fall back to the firm's own assumption set,
  // by property type, rather than to a single figure hardcoded here. The
  // screening tier already resolves them that way, and two tiers pricing the
  // same asset off different house defaults — 35% opex here against the firm's
  // 21% for retail — is a divergence neither tier can be held to.
  const vacancyRate = deal.vacancyRate ?? firmDefault('vacancyRate', propertyType) ?? 5;
  const operatingExpenseRatio =
    deal.operatingExpenseRatio ?? firmDefault('operatingExpenseRatio', propertyType) ?? 35;
  const a = { ...DEFAULT_ASSUMPTIONS, ...overrides, ...(deal.assumptions || {}) };

  const propertyTaxRate = deal.propertyTaxRate ?? getPropertyTaxRate(location);
  const leaseUpMonths = a.leaseUpMonths ?? typeCfg.leaseUpMonths ?? 12;
  // Lenders hold construction-to-perm debt interest-only until the asset
  // stabilises; amortising from completion charges principal against a
  // building that is still leasing up.
  const interestOnlyMonths = a.interestOnlyMonths ?? leaseUpMonths;
  const expenseRecoveryRate = deal.expenseRecoveryRate ?? typeCfg.expenseRecoveryRate ?? 0;
  const capexReserveAnnual =
    typeCfg.revenueBasis === 'unit' && units > 0
      ? (typeCfg.capexReservePerUnit ?? 300) * units
      : (typeCfg.capexReservePerSF ?? 0.25) * buildingSize;

  // Budget ------------------------------------------------------------------
  // Line items mirror a standard sources & uses schedule so the UI can render
  // it directly: contingency and the interest reserve are their own lines
  // rather than being folded into hard cost.
  const land = Math.max(0, purchasePrice);
  const hardCost = Math.max(0, constructionCost);
  const softCost = hardCost * (deal.softCostPct ?? constCfg.softCostPct);
  const ffe = Math.max(0, deal.ffe ?? 0);
  const contingencyRate = deal.contingencyRate ?? constCfg.contingency;
  const contingency = (hardCost + softCost + ffe) * contingencyRate;
  const financingCosts = Math.max(0, deal.financingCosts ?? 0);
  const baseProjectCost = land + hardCost + softCost + ffe + contingency + financingCosts;

  const equityCommitment = baseProjectCost * (downPayment / 100);
  const loanCommitment = baseProjectCost - equityCommitment;
  const monthlyRate = interestRate / 100 / 12;

  // Overridable per deal so a stabilised acquisition — bought and let, with no
  // works — can be modelled without inventing a construction period for it.
  const C = Math.max(0, Math.round(deal.constructionMonths ?? constCfg.timeframe ?? 0));
  const N = Math.max(0, Math.round(holdPeriod * 12));

  if (N === 0 || baseProjectCost <= 0) {
    return degenerateResult({
      baseProjectCost, propertyTaxRate, equityCommitment, loanCommitment,
      interestRate, loanTerm, a, C, N,
    });
  }

  const stabilizedOcc = Math.max(0.01, 1 - vacancyRate / 100);
  // DELIBERATE SIMPLIFICATION, and it does NOT match operating.goingInNOI below.
  // The renovation-period schedule credits in-place income net of opex only: no
  // property tax, no capital reserve, no occupancy-scaled recoveries. The
  // going-in cap rate nets all three, which is the institutional definition, so
  // the two differ by up to 312 bps on the same basis (Alamo Ridge: 8.20% here
  // against 5.08% reported). Reconciling them means charging tax and reserves
  // through the renovation months, which lowers the modelled return on every
  // repositioning deal — an underwriting-policy change, not a rendering one.
  // Flagged rather than made silently; until then no surface may present this
  // figure and the going-in cap rate as the same measure.
  const inPlaceMonthlyNoi = constCfg.hasInPlaceIncome
    ? (a.inPlaceRevenue / 12) * (1 - operatingExpenseRatio / 100)
    : 0;

  // Cost draw schedule: land at closing, hard+soft straight-line across the
  // construction period. (An S-curve is more realistic; straight-line is the
  // conservative, auditable default and is overridable via `drawSchedule`.)
  const spreadCost = hardCost + softCost + ffe + contingency;
  const costAt = (i) => {
    // Land and financing costs are incurred at closing; everything else draws
    // straight-line across the construction period. With no construction
    // period there is no draw loop at all — that case is funded at closing,
    // below, rather than by a branch here that nothing would ever call.
    let c = i === 0 ? land + financingCosts : 0;
    if (i < C) c += spreadCost / C;
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

  // Closing-only funding. The draw loop above runs `for (i = 0; i < C; i++)`,
  // so a project with no construction period never enters it: without this the
  // budget is never funded, no equity is drawn, the permanent balance is zero
  // and the schedule shows an asset acquired for free. The split is the same
  // one the loop applies — equity first, then the loan, overrun to equity.
  let closingEquityDraw = 0;
  let closingCost = 0;
  if (C === 0 && baseProjectCost > 0) {
    closingCost = baseProjectCost;
    closingEquityDraw = Math.min(baseProjectCost, Math.max(0, equityCommitment));
    loanDrawn = Math.min(baseProjectCost - closingEquityDraw, Math.max(0, loanCommitment));
    const overrun = baseProjectCost - closingEquityDraw - loanDrawn;
    if (overrun > 1e-9) closingEquityDraw += overrun;
    equityDrawn = closingEquityDraw;
    loanBalance = loanDrawn;
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
    const opexAtFullOccupancy =
      (grossRevenue / 12) * (operatingExpenseRatio / 100) * Math.pow(1 + a.expenseGrowth, yr);
    const opexBase = opexAtFullOccupancy * stabilizedOcc;
    const opex = opexBase * ((1 - a.variableOpexShare) + a.variableOpexShare * (occ / stabilizedOcc));

    const assessed = totalProjectCost * Math.pow(1 + a.assessmentGrowth, yr);
    const tax = (assessed * (propertyTaxRate / 100)) / 12;
    const reserve = (capexReserveAnnual / 12) * Math.pow(1 + a.expenseGrowth, yr);

    // Expense reimbursements. Under NNN and NN leases the tenant repays
    // operating cost and property tax pro rata to occupied space — without
    // this an industrial or retail deal in Texas, where tax runs 2.3-2.8% of
    // basis, cannot be modelled at all. Recoveries scale with occupancy:
    // vacant space has nobody to bill, and the landlord eats its share.
    const recoveries = (opex + tax) * expenseRecoveryRate * occ;

    return {
      gpr, occ, egi, recoveries, opex, tax, reserve,
      opexAtFullOccupancy,
      noi: egi + recoveries - opex - tax - reserve,
    };
  };

  let balance = permanentLoanBalance;
  for (let t = 0; t < N; t++) {
    // The full-occupancy expense budget is a break-even input, not a line in
    // the schedule; keeping it out of months[] keeps the reported cash flow
    // statement to the figures that actually happen.
    const { opexAtFullOccupancy, ...m } = operatingMonth(t);
    const interest = balance * monthlyRate;
    let debtService;
    if (t < interestOnlyMonths) {
      debtService = interest;
    } else {
      debtService = Math.min(payment, balance + interest);
      balance = Math.max(0, balance + interest - debtService);
    }
    const cashFlow = m.noi - debtService;
    const equityDraw = t === 0 ? closingEquityDraw : 0;
    months.push({
      index: C + t,
      phase: t < leaseUpMonths ? 'lease-up' : 'stabilized',
      cost: t === 0 ? closingCost : 0,
      ...m,
      interest,
      debtService,
      equityDraw,
      loanBalance: balance,
      cashFlow,
      equityFlow: cashFlow - equityDraw,
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
  let stabilizedGPR = 0;
  // Break-even measures cost at full occupancy, so this is the accumulator the
  // stabilised window keeps; the schedule's own opex is on months[].
  let stabilizedOpexAtFullOccupancy = 0;
  let stabilizedTax = 0;
  let stabilizedReserve = 0;
  let occupancySum = 0;
  for (let t = stabStart; t < stabStart + 12; t++) {
    const projected = operatingMonth(t);
    stabilizedNOI += projected.noi;
    stabilizedGPR += projected.gpr;
    stabilizedOpexAtFullOccupancy += projected.opexAtFullOccupancy;
    stabilizedTax += projected.tax;
    stabilizedReserve += projected.reserve;
    occupancySum += projected.occ;
    const m = months[C + t];
    stabilizedDebtService += m ? m.debtService : payment;
  }
  // Averaged over the same window as every other stabilised figure. A short
  // hold can leave that window still leasing up, and reporting the input
  // occupancy there would overstate the cushion over break-even.
  const stabilizedOccupancy = occupancySum / 12;

  // Break-even occupancy: where revenue exactly covers cash outgoings.
  //
  // Cost and revenue are both struck at FULL occupancy. The schedule budgets
  // opex against effective income — an expense ratio is quoted that way — so
  // its stabilised opex shrinks as the vacancy assumption rises. Pricing that
  // shrunken budget against revenue at 100% mixes two occupancy bases, and the
  // metric then FALLS as vacancy rises: the same building, rents and debt reads
  // safer the emptier it is underwritten, and the covenant flag goes quiet on
  // exactly the deals that need it. Grossing opex to 100% makes break-even a
  // property of the asset's cost structure and its debt, independent of the
  // vacancy forecast — which is what the cushion against underwritten
  // occupancy is for — and is the conservative reading a credit committee
  // tests, since operating cost does not leave with the tenants.
  //
  // Expense reimbursements belong in the denominator, because under NNN they
  // are revenue that arrives with occupancy. The two alternatives both break on
  // the 642,000 SF industrial sample, an asset covering 1.36x: omitting them
  // reads 1.25, a break-even above full occupancy; netting them out of the
  // numerator reads 0.69, because that credits at 100% a revenue stream nobody
  // is there to pay. In the denominator they are 0.80, and for a gross-lease
  // type the recovery rate is zero and the term disappears.
  const recoveryPotential = (stabilizedOpexAtFullOccupancy + stabilizedTax) * expenseRecoveryRate;
  const grossPotentialRevenue = stabilizedGPR + recoveryPotential;
  const stabilizedOutgoings =
    stabilizedOpexAtFullOccupancy + stabilizedTax + stabilizedReserve + stabilizedDebtService;
  // No potential rent means there is no occupancy to solve for. Reimbursement
  // potential alone would otherwise report a break-even for a net-leased
  // building with nothing to let, because tax is charged on basis either way.
  const breakEvenOccupancy = stabilizedGPR > 0 ? stabilizedOutgoings / grossPotentialRevenue : null;

  // Going-in cap rate — NOT yield on cost, and not interchangeable with it.
  // This prices the income already in place against what is paid for it; yield
  // on cost prices stabilised income against everything spent to get there. A
  // ground-up deal has no in-place income, so the number does not exist and
  // must read n/a rather than borrow the stabilised figure.
  //
  // The basis is the purchase price. Construction draws are excluded even
  // though the first of them lands in month zero: renovation spend buys the
  // stabilised income, not the income already in place, and folding it in would
  // turn this into a second yield-on-cost. Loan fees are excluded because this
  // is a property-level, unlevered yield — including them makes it move with
  // the capital structure and levies property tax on lender fees.
  const acquisitionBasis = land > 0 ? land : null;
  const inPlaceRevenue = constCfg.hasInPlaceIncome ? Math.max(0, a.inPlaceRevenue) : 0;
  // WHY the rate is missing, decided once here rather than re-derived by each
  // surface. Three different facts about a deal collapse to the same null, and
  // a surface guessing between them printed "a ground-up deal has no going-in
  // yield" on a tenant-improvement deal and on an acquisition with $3.4m of
  // in-place income whose purchase price was simply blank.
  let goingInCapUnavailable = null;
  if (!constCfg.hasInPlaceIncome) goingInCapUnavailable = 'ground-up';
  else if (!(inPlaceRevenue > 0)) goingInCapUnavailable = 'no-in-place-income';
  else if (acquisitionBasis === null) goingInCapUnavailable = 'no-acquisition-basis';
  else if (!(grossRevenue > 0)) goingInCapUnavailable = 'no-revenue-base';

  let goingInNOI = null;
  if (goingInCapUnavailable === null) {
    // In-place revenue against gross potential rent is the occupancy already
    // achieved, and every term below uses it exactly as the STABILISED operating
    // schedule uses occupancy, so this is comparable to stabilised NOI and to
    // yield on cost. It is deliberately NOT comparable to months[].noi during
    // the renovation period, which is grossed of tax and reserves — see the
    // note on inPlaceMonthlyNoi above.
    const inPlaceOcc = Math.min(1, inPlaceRevenue / grossRevenue);
    const opexAtFullOccupancy = grossRevenue * (operatingExpenseRatio / 100);
    // Striking opex on in-place revenue instead would make a half-empty
    // building look half as expensive to run — the same error the schedule
    // avoids by budgeting off the revenue base rather than off actual EGI.
    const inPlaceOpex =
      opexAtFullOccupancy * ((1 - a.variableOpexShare) + a.variableOpexShare * inPlaceOcc);
    const inPlaceTax = acquisitionBasis * (propertyTaxRate / 100);
    // Recoveries scale with occupancy — vacant space has nobody to bill —
    // exactly as they do in the schedule. Credited at 100% on a part-leased
    // building they can exceed the entire in-place rent roll, which is how a
    // negative in-place NOI comes to report a positive going-in cap rate.
    const inPlaceRecoveries = (inPlaceOpex + inPlaceTax) * expenseRecoveryRate * inPlaceOcc;
    // Tax and reserves are netted here, on the same definition of NOI the
    // STABILISED operating schedule uses. A going-in cap gross of a 2.81%
    // Houston tax bill overstates the yield by most of 200 bps, which is exactly
    // the kind of error reporting this number separately is meant to prevent.
    goingInNOI = inPlaceRevenue + inPlaceRecoveries - inPlaceOpex - inPlaceTax - capexReserveAnnual;
  }
  const goingInCapRate = goingInNOI === null ? null : goingInNOI / acquisitionBasis;

  const yieldOnCost = totalProjectCost > 0 ? stabilizedNOI / totalProjectCost : null;
  const developmentSpreadBps =
    yieldOnCost !== null ? (yieldOnCost - exitCapRate / 100) * 10000 : null;
  const stabilizedDSCR = stabilizedDebtService > 0 ? stabilizedNOI / stabilizedDebtService : null;
  const debtYield = permanentLoanBalance > 0 ? stabilizedNOI / permanentLoanBalance : null;

  // Minimum DSCR across any rolling operating year, and separately across any
  // rolling year from stabilization onward — the window a covenant governs.
  let minDSCR = null;
  let minStabilizedDSCR = null;
  for (let t = 0; t + 12 <= N; t++) {
    let n = 0;
    let d = 0;
    for (let k = t; k < t + 12; k++) { n += months[C + k].noi; d += months[C + k].debtService; }
    if (d > 0) {
      const v = n / d;
      minDSCR = minDSCR === null ? v : Math.min(minDSCR, v);
      if (t >= stabStart) minStabilizedDSCR = minStabilizedDSCR === null ? v : Math.min(minStabilizedDSCR, v);
    }
  }

  const profit = equityFlows.reduce((s, f) => s + f, 0);

  return {
    months,
    annual: rollUpAnnual(months),
    assumptions: { ...a, leaseUpMonths, interestOnlyMonths, propertyTaxRate, capexReserveAnnual, expenseRecoveryRate },
    budget: {
      land, hardCost, softCost, ffe, contingency, contingencyRate, financingCosts,
      baseProjectCost, capitalizedInterest, totalProjectCost,
      lines: [
        { key: 'land',           label: 'Land & acquisition',   amount: land },
        { key: 'hardCost',       label: 'Hard cost',            amount: hardCost },
        { key: 'softCost',       label: 'Soft cost',            amount: softCost },
        { key: 'ffe',            label: 'FF&E and amenities',   amount: ffe },
        { key: 'contingency',    label: 'Contingency',          amount: contingency },
        { key: 'financingCosts', label: 'Financing costs',      amount: financingCosts },
        { key: 'interestReserve',label: 'Interest reserve',     amount: capitalizedInterest },
      ].filter((l) => l.amount > 0),
    },
    financing: {
      equityCommitment, loanCommitment, permanentLoanBalance,
      interestRate, loanTerm,
      monthlyPayment: payment, annualDebtService: payment * 12,
      // Measured as the permanent balance against total project cost, on the
      // same basis the debt sizer and the covenant test use. Measuring the
      // commitment against base cost instead omits capitalised interest from
      // both sides and reports 70.0% on a deal funded at 70.9%: the interest
      // reserve is borrowed money, and it is spent on the project.
      ltc: totalProjectCost > 0 ? permanentLoanBalance / totalProjectCost : null,
      gpCoInvest: equityCommitment * (deal.gpCoInvestShare ?? 0.20),
      lpEquity: equityCommitment * (1 - (deal.gpCoInvestShare ?? 0.20)),
      sizing: null,   // populated only on the sizeDebtToConstraints path
    },
    exit: { forwardNoi, grossSalePrice, costOfSale, loanPayoff, netSaleProceeds, exitCapRate },
    returns: { leveredIRR, unleveredIRR, equityMultiple, peakEquity, profit, totalEquityInvested: outflows, totalDistributions: inflows },
    operating: {
      stabilizedNOI, stabilizedDebtService, stabilizedOccupancy,
      grossPotentialRevenue, stabilizedOutgoings, breakEvenOccupancy,
      yieldOnCost, goingInCapRate, goingInNOI, acquisitionBasis, goingInCapUnavailable,
      developmentSpreadBps, stabilizedDSCR, minDSCR, minStabilizedDSCR, debtYield,
      stabilizationMonth: C + stabStart, interestOnlyMonths,
    },
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
      months: slice.length,
      partial: slice.length < 12,
      gpr: sum('gpr'),
      egi: sum('egi'),
      recoveries: sum('recoveries'),
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

function degenerateResult({ baseProjectCost, propertyTaxRate, equityCommitment, loanCommitment, interestRate, loanTerm, a, C, N }) {
  // Every figure that needs a schedule is unknown, not zero. This model is
  // marked `incomplete`, and a caller reading a confident 0 off it — no NOI, no
  // equity at risk, no profit — is reading a claim the engine never made.
  const nulls = {
    leveredIRR: null, unleveredIRR: null, equityMultiple: null,
    peakEquity: null, profit: null, totalEquityInvested: null, totalDistributions: null,
  };
  return {
    months: [], annual: [],
    assumptions: { ...a, propertyTaxRate },
    budget: { land: 0, hardCost: 0, softCost: 0, ffe: 0, contingency: 0, contingencyRate: 0, financingCosts: 0, baseProjectCost, capitalizedInterest: 0, totalProjectCost: baseProjectCost, lines: [] },
    financing: { equityCommitment, loanCommitment, permanentLoanBalance: 0, interestRate, loanTerm, monthlyPayment: 0, annualDebtService: 0, ltc: null, gpCoInvest: 0, lpEquity: 0, sizing: null },
    exit: { forwardNoi: 0, grossSalePrice: 0, costOfSale: 0, loanPayoff: 0, netSaleProceeds: 0, exitCapRate: 0 },
    returns: nulls,
    operating: {
      stabilizedNOI: null, stabilizedDebtService: null, stabilizedOccupancy: null,
      grossPotentialRevenue: null, stabilizedOutgoings: null, breakEvenOccupancy: null,
      yieldOnCost: null, goingInCapRate: null, goingInNOI: null, acquisitionBasis: null,
      // An unmodelled deal has not established that any of the three specific
      // reasons applies, so the reason is unknown too rather than asserted.
      goingInCapUnavailable: null,
      developmentSpreadBps: null, stabilizedDSCR: null, minDSCR: null, minStabilizedDSCR: null,
      debtYield: null, stabilizationMonth: 0, interestOnlyMonths: 0,
    },
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
    // There is deliberately no `capRate` key aliasing yield on cost. It was the
    // original mislabelling — a development yield presented as a cap rate — and
    // nothing reads it; keeping it would let a UI tile pick the wrong one back up.
    // The real cap rate, null for ground-up. Every rate in this flat bag is
    // percent-scaled, which is why break-even occupancy is not mirrored here:
    // it is a ratio, and two conventions under one shape is how a UI ends up
    // rendering 0.81 as "0.81%". Read it from model.operating instead.
    goingInCapRate: pct(r.operating.goingInCapRate),
    developmentSpreadBps: r.operating.developmentSpreadBps,
    dscr: r.operating.stabilizedDSCR,
    minDSCR: r.operating.minDSCR,
    minStabilizedDSCR: r.operating.minStabilizedDSCR,
    debtYield: pct(r.operating.debtYield),
    exitValue: r.exit.grossSalePrice,
    netSaleProceeds: r.exit.netSaleProceeds,
    // A deal with no cash flow year and a deal that has not been modelled are
    // different claims, and both used to come back as 0.
    cashFlow: r.annual.find((y) => y.cashFlow !== 0)?.cashFlow ?? null,
    cashOnCash: (() => {
      const firstYear = r.annual[r.timeline.constructionMonths >= 12 ? 1 : 0]?.cashFlow;
      if (!(r.financing.equityCommitment > 0) || firstYear === undefined) return null;
      return (firstYear / r.financing.equityCommitment) * 100;
    })(),
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
