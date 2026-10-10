/**
 * Screening tier — rank thousands of candidates, underwrite the shortlist.
 *
 * `runModel()` builds a 78-month schedule and solves an IRR by bisection. That
 * is the right cost for the deal you are taking to committee and the wrong cost
 * for the ten thousand parcels a sourcing feed drops on you overnight. This
 * module is the cheap tier in front of it: one pass of arithmetic per candidate,
 * no schedule, no IRR, no iteration. Its job is RECALL — do not lose a good deal
 * before a human ever sees it — not precision.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A SCREENING NUMBER IS NOT AN UNDERWRITTEN NUMBER
 *
 * The failure mode this module is designed against is a screen estimate being
 * read, pasted or charted as if it came off the model. Three deliberate choices
 * enforce the distinction, and none of them are cosmetic:
 *
 *   1. Every metric key is prefixed `estimated…`, and NO key on the result
 *      collides with a key on `runModel().operating`. A screen result cannot be
 *      dropped into a component that expects an underwritten one — it renders
 *      empty rather than plausible. `screen.test.js` asserts the disjointness.
 *   2. Every yield ships as a BAND as well as a point, sized by confidence. A
 *      point estimate invites a comparison the input data cannot support.
 *   3. Confidence is capped at `CONFIDENCE_CEILING` ('moderate'). The top of
 *      the screening scale sits below the bottom of the underwriting scale, by
 *      construction, no matter how complete the candidate record is. Screening
 *      omits real economics (see SCREEN_OMISSIONS); complete inputs do not make
 *      an omitted mechanism reappear.
 *
 * `provenance` mirrors the seed/sourced marking in markets.js, for the same
 * reason: the UI has to be able to degrade visibly, and it can only do that if
 * the data says what it is.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { amortizingPayment, DEFAULT_ASSUMPTIONS } from './finance';
import { propertyTypes, constructionTypes } from './propertyTypes';
import { resolveTaxRate } from './markets';
import { firmDefault } from './firmDefaults';

export const SCREEN_PROVENANCE = {
  tier: 'screen',
  dataQuality: 'estimate',
  underwritten: false,
  method: 'single-period arithmetic; no monthly schedule, no IRR, no escalation, no lease-up',
  source: 'Screening tier — re-run through runModel() before any investment decision',
  asOf: null,
};

/**
 * The mechanisms the full model prices and the screen does not, with the
 * direction each one pushes the screen estimate.
 *
 * This is the documented divergence. It is exported rather than buried in a
 * comment because the UI should be able to show a user WHY a screened 9.1%
 * came back as an underwritten 7.4%, and because a reviewer arguing with the
 * screen's accuracy should be arguing with this list.
 *
 * `screenBias` is the direction the SCREEN errs relative to the model:
 * 'high' = the screen flatters the deal, 'low' = the screen is conservative.
 */
export const SCREEN_OMISSIONS = [
  {
    key: 'capitalizedInterest',
    screenBias: 'high',
    detail: 'Basis is the capital plan as supplied. The model adds the construction interest reserve to basis, which lowers yield on cost.',
  },
  {
    key: 'ffe',
    screenBias: 'high',
    detail: 'FF&E and financing costs are priced when the candidate carries them (see costLoad), and omitted from basis when it does not — a sourcing record usually does not.',
  },
  {
    key: 'revenueAndExpenseEscalation',
    screenBias: 'low',
    detail: 'Held in today\'s dollars. The model measures its stabilised year after construction and lease-up, so those revenues have escalated — partially offsetting the basis omissions above.',
  },
  {
    key: 'leaseUp',
    screenBias: 'none',
    detail: 'Stabilised occupancy is assumed from day one. The model measures yield on cost and stabilised DSCR after lease-up, so this does not bias the figures compared — but the screen has nothing to say about coverage during absorption, which is where a development actually fails.',
  },
  {
    key: 'assessmentGrowth',
    screenBias: 'low',
    detail: 'Property tax is struck on today\'s assessed value. The model escalates the assessment across the hold.',
  },
  {
    key: 'interestOnlyPeriod',
    screenBias: 'none',
    detail: 'DSCR is measured against a fully-amortising constant payment. The model holds the loan interest-only THROUGH stabilisation and its stabilised year begins where that ends, so the compared figures agree; the easier coverage sits in the lease-up months the screen does not report.',
  },
  {
    key: 'exit',
    screenBias: 'none',
    detail: 'No sale, no IRR, no equity multiple, no development spread. A screen cannot rank on any return that requires dated cash flows.',
  },
];

/**
 * Screening confidence never reaches the top of the scale.
 *
 * A candidate record can be complete and the estimate still omits everything in
 * SCREEN_OMISSIONS. Confidence describes the METHOD as much as the inputs, so
 * the ceiling is a property of the tier, not of any one candidate.
 */
export const CONFIDENCE_CEILING = 'moderate';

/**
 * Half-width of the reported yield band, in basis points, by confidence level.
 *
 * These are judgment, not a fitted error distribution — there is no realised
 * screen-to-underwrite history in this codebase to fit against. They are sized
 * so the band spans the divergence actually observed against the sample
 * portfolio (see screen.test.js), which is the only evidence available. Replace
 * with fitted residuals once a firm has screened and closed enough deals.
 */
export const YIELD_BAND_BPS = { moderate: 75, low: 150, indicative: 250 };

/** Leverage assumed for the screening coverage test, from the firm's own box. */
export const SCREEN_DEFAULTS = {
  ltv: 1 - firmDefault('downPayment') / 100,
  interestRate: firmDefault('interestRate'),
  amortYears: firmDefault('loanTerm'),
};

/**
 * A capital budget on a sourcing record is a HARD-COST number. A project basis
 * is not: soft cost sits on top of hard cost and contingency sits on top of
 * both, exactly as finance.js builds them.
 *
 * Screening without this load is not a smaller error, it is a biased one.
 * Measured against the sample portfolio, an unloaded screen flattered every
 * ground-up deal by 165-280 bps of yield while landing within 40 bps on every
 * acquisition and TI deal — so the ranking sorted by construction type before
 * it sorted by quality, and the shortlist filled up with ground-up deals for a
 * reason that had nothing to do with their economics. A systematic bias that
 * correlates with a candidate attribute is the one kind of screening error that
 * a downstream underwriting pass cannot undo, because the deal it displaced was
 * never underwritten.
 *
 * FF&E, financing costs and the interest reserve stay omitted: a candidate
 * record does not carry them, and guessing them would be inventing basis.
 */
export function costLoadFactor(constructionType) {
  const cfg = constructionTypes[constructionType];
  if (!cfg) return null;
  return (1 + cfg.softCostPct) * (1 + cfg.contingency);
}

/**
 * An unlabelled candidate carrying a capital budget is far more often a
 * repositioning than a ground-up development, and 'acquisition' also carries
 * the smaller load — so an unknown construction type cannot inflate a
 * candidate's basis and quietly drop it off the shortlist.
 */
const DEFAULT_CONSTRUCTION_TYPE = 'acquisition';

const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * Gross potential revenue, tried in the order the property type actually quotes
 * rent. A multifamily record carrying both a current per-unit rent and a stale
 * per-SF figure must screen on the per-unit number, not on whichever field the
 * feed happened to populate first.
 */
function grossPotentialRevenue(candidate, typeCfg) {
  // Without a known property type there is no native rent basis to prefer, and
  // picking whichever field the feed happened to populate is how a warehouse
  // quoted per SF gets screened on a car wash's site revenue.
  if (!typeCfg) return { estimatedGPR: null, rentBasis: null };
  const units = finite(candidate.units);
  const sf = finite(candidate.buildingSize);
  const perUnit = finite(candidate.rentPerUnitMonthly);
  const perSF = finite(candidate.rentPerSFAnnual);
  const annual = finite(candidate.annualRevenue);

  const byUnit = perUnit !== null && units !== null && units > 0
    ? { estimatedGPR: units * perUnit * 12, rentBasis: 'unit' } : null;
  const bySF = perSF !== null && sf !== null && sf > 0
    ? { estimatedGPR: sf * perSF, rentBasis: 'psf' } : null;
  const bySite = annual !== null ? { estimatedGPR: annual, rentBasis: 'site' } : null;

  const preferred = { unit: byUnit, psf: bySF, site: bySite }[typeCfg.revenueBasis];
  return preferred || byUnit || bySF || bySite || { estimatedGPR: null, rentBasis: null };
}

/**
 * Screen one candidate.
 *
 * Everything here is closed-form: one multiplication chain for income, one
 * amortisation formula for coverage. Nothing iterates, and nothing depends on
 * the hold period — a screen result is a stabilised snapshot, not a projection.
 * `screen.test.js` pins that independence, because the day this quietly starts
 * reading a hold period is the day it stopped being a screening tier.
 *
 * @param {Object} candidate
 * @param {string} candidate.propertyType
 * @param {string} candidate.location            Free text; resolved via markets.js.
 * @param {number} [candidate.units]
 * @param {number} [candidate.buildingSize]      SF.
 * @param {number} [candidate.rentPerUnitMonthly]
 * @param {number} [candidate.rentPerSFAnnual]
 * @param {number} [candidate.annualRevenue]     Site-basis revenue (car wash).
 * @param {number} [candidate.askingPrice]
 * @param {number} [candidate.capitalBudget]     Capital plan on top of the asking price.
 * @param {number} [candidate.assessedValue]     Falls back to basis, at a confidence cost.
 * @param {number} [candidate.vacancyRate]       Percent.
 * @param {number} [candidate.operatingExpenseRatio] Percent, EXCLUDING property tax.
 * @param {number} [candidate.propertyTaxRate]   Percent of assessed value.
 * @param {number} [candidate.expenseRecoveryRate] 0-1.
 * @param {Object} [assumptions] ltv / interestRate / amortYears overrides.
 * @returns {Object} estimates + confidence + provenance. Never a schedule.
 */
export function screenProperty(candidate = {}, assumptions = {}) {
  const a = { ...SCREEN_DEFAULTS, ...assumptions };

  // Anything the candidate did not supply is recorded, not silently absorbed:
  // an estimate resting on five house defaults is a different claim from one
  // resting on five sourced figures, and confidence has to be able to say so.
  const defaulted = [];
  const missing = [];
  const malformed = [];

  // A field the feed supplied in a shape this module cannot read — '5200000'
  // out of a CSV, say — is not the same as a field it did not supply. Treating
  // the two alike swapped the basis definition with nothing on the record to
  // say why, so a rejected value is recorded as rejected.
  const num = (key) => {
    const raw = candidate[key];
    if (raw === undefined || raw === null) return null;
    const value = finite(raw);
    if (value === null) malformed.push(key);
    return value;
  };

  // An unrecognised property type is not a missing field, it is a category
  // error: revenue basis, expense load, recovery rate and reserve convention
  // all hang off it. Screening a warehouse as a car wash reads 278 bps against
  // its industrial figure, and does so at the top of the confidence scale. The
  // candidate keeps its place in the batch and ranks null — unpriceable, which
  // is what it is, rather than priced as something else.
  const typeCfg = propertyTypes[candidate.propertyType] || null;
  if (!typeCfg) missing.push('propertyType');

  const { estimatedGPR, rentBasis } = grossPotentialRevenue(candidate, typeCfg);
  if (estimatedGPR === null && typeCfg) missing.push('rent');

  const askingPrice = num('askingPrice');
  const capitalBudget = num('capitalBudget');
  const assessedValue = num('assessedValue');
  const ffe = num('ffe');
  const financingCosts = num('financingCosts');

  const constructionType = constructionTypes[candidate.constructionType]
    ? candidate.constructionType
    : DEFAULT_CONSTRUCTION_TYPE;
  const constCfg = constructionTypes[constructionType];
  const allIn = Boolean(candidate.capitalBudgetIsAllIn);
  const costLoad = allIn ? 1 : costLoadFactor(constructionType);
  // FF&E carries contingency but not the soft-cost load, mirroring finance.js,
  // where contingency is struck on hard + soft + FF&E. Financing costs are a
  // flat line in the budget and carry neither.
  const ffeLoad = allIn ? 1 : 1 + constCfg.contingency;
  if (capitalBudget !== null && !allIn && !constructionTypes[candidate.constructionType]) {
    defaulted.push('constructionType');
  }

  let estimatedBasis = null;
  let basisSource = null;
  if (askingPrice !== null || capitalBudget !== null) {
    estimatedBasis = (askingPrice ?? 0) + (capitalBudget ?? 0) * costLoad
      + (ffe ?? 0) * ffeLoad + (financingCosts ?? 0);
    basisSource = capitalBudget !== null && askingPrice !== null ? 'asking+capital'
      : askingPrice !== null ? 'asking' : 'capital';
  } else if (assessedValue !== null) {
    // Assessed value is a tax authority's opinion of value, not a price. It is
    // the last resort for basis and is labelled so the ranking can be read with
    // that in mind.
    estimatedBasis = assessedValue;
    basisSource = 'assessed';
  }
  // A basis of zero is not a free building, it is a price nobody supplied.
  // Publishing it produces a zero tax bill, a zero loan and a zero coverage
  // test, all of them reading as measured answers.
  if (!(estimatedBasis > 0)) {
    estimatedBasis = null;
    basisSource = null;
    missing.push('basis');
  }

  const vacancyRate = num('vacancyRate');
  // Floored as finance.js floors it: a vacancy input at or above 100 would
  // otherwise divide the whole estimate by zero or by a negative occupancy.
  const occupancy = Math.max(
    0.01,
    1 - (vacancyRate ?? firmDefault('vacancyRate', candidate.propertyType)) / 100,
  );
  if (vacancyRate === null) defaulted.push('vacancyRate');
  // The house standard for the type, never this candidate's own number — the
  // anchor the fixed operating budget is struck on. Same fallback chain as
  // finance.js, for the same reason: an unrecognised type falls through to the
  // firm-wide figure, and what it must never fall back to is `vacancyRate`.
  const houseOccupancy = Math.max(
    0.01,
    1 - (firmDefault('vacancyRate', candidate.propertyType) ?? 5) / 100,
  );

  const operatingExpenseRatio = num('operatingExpenseRatio');
  const opexRatio = operatingExpenseRatio
    ?? firmDefault('operatingExpenseRatio', candidate.propertyType)
    ?? typeCfg?.avgOpEx;
  if (operatingExpenseRatio === null) defaulted.push('operatingExpenseRatio');

  const tax = resolveTaxRate(candidate.location);
  const propertyTaxRate = num('propertyTaxRate');
  const taxRate = propertyTaxRate ?? tax.rate;
  if (propertyTaxRate === null && tax.basis !== 'market') defaulted.push('propertyTaxRate');

  // The largest single NOI lever on a net-leased asset, and the one assumption
  // that used to be defaulted without saying so.
  const expenseRecoveryRate = num('expenseRecoveryRate');
  const recoveryRate = expenseRecoveryRate ?? typeCfg?.expenseRecoveryRate ?? 0;
  if (expenseRecoveryRate === null) defaulted.push('expenseRecoveryRate');

  // Construction-period property tax on the land, the same line finance.js
  // charges as `budget.landCarry`. The screen has everything it needs to
  // compute it — the asking price IS the land basis, the market tax rate is
  // resolved above, and constructionTypes carries the build duration — and
  // until it did, it understated basis by exactly the carry and overstated
  // yield by the carry's share of it. That bias is not random: it lands only on
  // ground-up candidates, hardest on a heavy land basis against a light capital
  // budget in a high-tax county, which is the one shape a Texas land screen
  // sees constantly. The screening guard in screen.test.js was widened to
  // tolerate it; charging the carry here is what lets that guard go back to
  // requiring the screen never to out-yield the model.
  //
  // Gated on `hasInPlaceIncome` exactly as the engine gates it: a repositioning
  // candidate pays the same bill through its renovation operating statement,
  // and charging it here as well would double it.
  const landCarry = constCfg && !constCfg.hasInPlaceIncome && askingPrice !== null && taxRate
    ? askingPrice * (taxRate / 100) * ((constCfg.timeframe ?? 0) / 12)
    : 0;
  if (landCarry > 0 && estimatedBasis !== null) estimatedBasis += landCarry;

  // Tax is struck on what the asset will be assessed at once it is producing
  // the income being screened. An assessment values the property AS IT STANDS,
  // and an assessor re-bases on completion, so a candidate with capital still
  // to spend is taxed on its finished basis: striking tax on a land-only
  // assessment while measuring yield on full project cost flattered every
  // ground-up deal by up to 216 bps. That is the construction-type-correlated
  // bias costLoadFactor exists to remove, arriving down a different input path.
  const stabilizedAssessment = capitalBudget !== null && capitalBudget > 0 ? null : assessedValue;
  const taxBase = stabilizedAssessment ?? estimatedBasis;
  const taxBaseSource = stabilizedAssessment !== null ? 'assessed'
    : estimatedBasis !== null ? 'basis-proxy' : null;
  // Supplying an assessment the screen cannot use must not raise confidence.
  if (taxBaseSource !== 'assessed') defaulted.push('assessedValue');

  const units = num('units');
  const sf = num('buildingSize');
  // Reserve definition mirrors finance.js so the two NOIs are the same NOI.
  // When neither a unit count nor a floor area is known the reserve is unknown,
  // and an NOI that quietly drops it would be measured on a different
  // definition from every other candidate in the batch — which is exactly the
  // corruption a ranking cannot survive. So the NOI goes null instead.
  let estimatedReserve = null;
  if (!typeCfg) {
    // No type, no reserve convention.
  } else if (typeCfg.revenueBasis === 'unit' && units !== null && units > 0) {
    estimatedReserve = (typeCfg.capexReservePerUnit ?? 300) * units;
  } else if (sf !== null && sf > 0) {
    estimatedReserve = (typeCfg.capexReservePerSF ?? 0.25) * sf;
  } else {
    missing.push('capexReserveBasis');
  }

  const estimatedEGI = estimatedGPR === null ? null : estimatedGPR * occupancy;
  // Opex on the SAME anchor finance.js uses: the fixed share is struck on the
  // firm's house vacancy for the property type, only the variable share moves
  // with this candidate's own occupancy.
  //
  // Budgeting the whole line off EGI — GPR x this deal's occupancy — is the
  // convention the engine abolished, and leaving it here did not merely make
  // the two tiers disagree. It made them disagree in the FLATTERING direction
  // on exactly the candidates a sourcing screen sees most: anything
  // underwritten above its house vacancy got a proportionally smaller fixed
  // operating budget, so the screen credited it with NOI the model would not
  // underwrite. On a multifamily candidate at 20% vacancy the screen ranked the
  // asset ABOVE the model by 20 bps of yield where it had ranked it 33 bps
  // below — the sign flip that screen.test.js calls the dangerous failure,
  // because a screen that ranks a deal better than the model is a screen that
  // sends an analyst to underwrite something that was never there.
  //
  // At the house vacancy this returns exactly `estimatedEGI x opexRatio`, the
  // figure the previous line produced, so a candidate at house standard is
  // unmoved and the two tiers reconcile to the cent as they always did.
  const vs = DEFAULT_ASSUMPTIONS.variableOpexShare;
  const estimatedOpex = estimatedEGI === null
    ? null
    : estimatedGPR * (opexRatio / 100) * ((1 - vs) * houseOccupancy + vs * occupancy);
  const estimatedTax = taxBase === null ? null : taxBase * (taxRate / 100);
  const estimatedRecoveries = estimatedOpex === null || estimatedTax === null
    ? null
    : (estimatedOpex + estimatedTax) * recoveryRate * occupancy;

  const noiKnown = estimatedEGI !== null && estimatedOpex !== null
    && estimatedTax !== null && estimatedRecoveries !== null && estimatedReserve !== null;
  const estimatedNOI = noiKnown
    ? estimatedEGI + estimatedRecoveries - estimatedOpex - estimatedTax - estimatedReserve
    : null;

  const estimatedYieldOnCost = estimatedNOI !== null && estimatedBasis > 0
    ? estimatedNOI / estimatedBasis
    : null;

  const estimatedLoanAmount = estimatedBasis === null ? null : estimatedBasis * a.ltv;
  const estimatedDebtService = estimatedLoanAmount === null
    ? null
    : amortizingPayment(estimatedLoanAmount, a.interestRate / 100, a.amortYears) * 12;
  const estimatedDSCR = estimatedNOI !== null && estimatedDebtService > 0
    ? estimatedNOI / estimatedDebtService
    : null;
  const estimatedDebtYield = estimatedNOI !== null && estimatedLoanAmount > 0
    ? estimatedNOI / estimatedLoanAmount
    : null;

  const confidence = gradeConfidence({
    defaulted, missing, malformed,
    rankable: estimatedYieldOnCost !== null,
    taxBasis: tax.basis,
  });

  return {
    candidate,
    tier: 'screen',
    estimates: {
      estimatedGPR,
      estimatedEGI,
      estimatedOpex,
      estimatedTax,
      estimatedRecoveries,
      estimatedReserve,
      estimatedNOI,
      estimatedBasis,
      landCarry,
      estimatedYieldOnCost,
      estimatedYieldBand: yieldBand(estimatedYieldOnCost, confidence.level),
      estimatedLoanAmount,
      estimatedDebtService,
      estimatedDSCR,
      estimatedDebtYield,
    },
    inputs: {
      rentBasis,
      basisSource,
      constructionType,
      costLoad,
      taxBaseSource,
      occupancy,
      opexRatio,
      propertyTaxRate: taxRate,
      expenseRecoveryRate: recoveryRate,
      ltv: a.ltv,
      interestRate: a.interestRate,
      amortYears: a.amortYears,
    },
    confidence,
    provenance: { ...SCREEN_PROVENANCE },
    omissions: SCREEN_OMISSIONS,
  };
}

/**
 * Confidence in one screened estimate.
 *
 * Deliberately coarse. A 0-100 screening score would invite exactly the
 * false-precision reading this module exists to prevent, and there is no
 * realised outcome data to calibrate a finer scale against.
 */
function gradeConfidence({ defaulted, missing, malformed, rankable, taxBasis }) {
  const base = {
    ceiling: CONFIDENCE_CEILING,
    defaulted,
    missing,
    malformed,
    taxRateBasis: taxBasis,
    underwritten: false,
    note: 'Screening estimate. Confidence is capped below any underwritten result regardless of input completeness.',
  };
  if (!rankable) return { ...base, level: 'insufficient' };
  // A field supplied in an unreadable shape cost the screen the same assumption
  // a missing one did, so it degrades confidence the same way.
  const substituted = defaulted.length + malformed.length;
  if (substituted === 0) return { ...base, level: CONFIDENCE_CEILING };
  return { ...base, level: substituted <= 2 ? 'low' : 'indicative' };
}

/** Point estimates invite comparisons the inputs cannot support; ship a band. */
function yieldBand(yieldOnCost, level) {
  const halfWidthBps = YIELD_BAND_BPS[level];
  if (yieldOnCost === null || halfWidthBps === undefined) return null;
  return { low: yieldOnCost - halfWidthBps / 10000, high: yieldOnCost + halfWidthBps / 10000, halfWidthBps };
}

/**
 * Screen a batch and rank it by estimated yield on cost, best first.
 *
 * Candidates the screen could not price keep their place in the output but rank
 * `null` — they are unranked, not last-ranked. Sorting them as zero would bury a
 * property whose only defect is a missing field in the feed, which is the same
 * recall failure as rejecting it outright.
 */
export function screenAll(candidates = [], assumptions = {}) {
  const screened = candidates.map((candidate, sourceIndex) => ({
    ...screenProperty(candidate, assumptions),
    sourceIndex,
  }));

  const ranked = screened.slice().sort((x, y) => {
    const a = x.estimates.estimatedYieldOnCost;
    const b = y.estimates.estimatedYieldOnCost;
    if (a === null && b === null) return x.sourceIndex - y.sourceIndex;
    if (a === null) return 1;
    if (b === null) return -1;
    // Ties fall back to input order so a re-screen of the same batch cannot
    // reshuffle a shortlist without any input having changed.
    return b - a || x.sourceIndex - y.sourceIndex;
  });

  let rank = 0;
  for (const result of ranked) {
    result.rank = result.estimates.estimatedYieldOnCost === null ? null : ++rank;
  }
  return ranked;
}

/**
 * Bridge a full deal record into a screening candidate.
 *
 * Sourcing candidates and underwriting deals are different shapes: a deal
 * carries a stabilised gross revenue, a candidate carries a market rent. This
 * derives the latter from the former so the two tiers can be compared on the
 * same portfolio — which is how the directional-agreement test in
 * screen.test.js is built, and how a firm would backtest the screen against its
 * own closed deals.
 *
 * It passes the deal's hard-cost budget through as a candidate capital budget
 * and lets the screen apply its own cost load, rather than handing over the
 * model's finished basis. The gap between the two is the divergence being
 * measured, and closing it here would make the comparison prove nothing.
 */
export function screeningCandidateFromDeal(deal = {}) {
  const typeCfg = propertyTypes[deal.propertyType] || propertyTypes.carwash;
  const revenue = finite(deal.grossRevenue);
  const units = finite(deal.units);
  const sf = finite(deal.buildingSize);

  const rent = {};
  if (typeCfg.revenueBasis === 'unit' && revenue !== null && units) {
    rent.rentPerUnitMonthly = revenue / units / 12;
  } else if (typeCfg.revenueBasis === 'psf' && revenue !== null && sf) {
    rent.rentPerSFAnnual = revenue / sf;
  } else if (revenue !== null) {
    rent.annualRevenue = revenue;
  }

  return {
    // Identity travels with the candidate: a ranked shortlist is useless if the
    // caller cannot say which property each row is.
    id: deal.id,
    name: deal.name,
    propertyType: deal.propertyType,
    location: deal.location,
    units: deal.units,
    buildingSize: deal.buildingSize,
    ...rent,
    constructionType: deal.constructionType,
    askingPrice: deal.purchasePrice,
    capitalBudget: deal.constructionCost,
    vacancyRate: deal.vacancyRate,
    operatingExpenseRatio: deal.operatingExpenseRatio,
    propertyTaxRate: deal.propertyTaxRate,
    // runModel honours every one of these. Dropping them screened the deal on
    // house defaults while the model underwrote it on the deal's own terms, so
    // the divergence being measured was partly the bridge's own doing — a
    // recovery-rate override alone moved the screen 198 bps and out of its band.
    expenseRecoveryRate: deal.expenseRecoveryRate,
    ffe: deal.ffe,
    financingCosts: deal.financingCosts,
  };
}
