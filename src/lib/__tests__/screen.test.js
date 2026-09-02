import { runModel } from '../finance';
import { SAMPLE_DEALS } from '../sampleDeals';
import {
  screenProperty, screenAll, screeningCandidateFromDeal, costLoadFactor,
  SCREEN_PROVENANCE, SCREEN_OMISSIONS, CONFIDENCE_CEILING, YIELD_BAND_BPS,
} from '../screen';

/**
 * A minimal candidate that prices cleanly, used where the test is about one
 * behaviour and not about the input plumbing.
 */
const candidate = {
  propertyType: 'retail',
  constructionType: 'acquisition',
  location: 'Tampa, FL',
  buildingSize: 18_000,
  rentPerSFAnnual: 31,
  askingPrice: 5_200_000,
  capitalBudget: 1_100_000,
  vacancyRate: 6,
  operatingExpenseRatio: 20,
  assessedValue: 5_000_000,
};

describe('screening arithmetic', () => {
  it('builds gross potential revenue on the basis the property type quotes rent', () => {
    const psf = screenProperty({ ...candidate, buildingSize: 10_000, rentPerSFAnnual: 20 });
    expect(psf.estimates.estimatedGPR).toBe(200_000);
    expect(psf.inputs.rentBasis).toBe('psf');

    const units = screenProperty({
      propertyType: 'multifamily', location: 'Austin, TX',
      units: 80, buildingSize: 72_000, rentPerUnitMonthly: 2_100, askingPrice: 20_000_000,
    });
    expect(units.estimates.estimatedGPR).toBe(80 * 2100 * 12);
    expect(units.inputs.rentBasis).toBe('unit');
  });

  it('prefers the type-native rent field over a stale one on the same record', () => {
    // A feed that populates both must not be screened on whichever field it
    // wrote first — the per-unit rent is the multifamily number.
    const both = screenProperty({
      propertyType: 'multifamily', location: 'Austin, TX',
      units: 80, buildingSize: 72_000,
      rentPerUnitMonthly: 2_100, rentPerSFAnnual: 40,
      askingPrice: 20_000_000,
    });
    expect(both.estimates.estimatedGPR).toBe(80 * 2100 * 12);
  });

  it('nets recoveries, opex, tax and reserve into NOI on the same definition as the model', () => {
    const r = screenProperty(candidate);
    const e = r.estimates;
    expect(e.estimatedEGI).toBeCloseTo(e.estimatedGPR * 0.94, 6);
    expect(e.estimatedOpex).toBeCloseTo(e.estimatedEGI * 0.20, 6);
    expect(e.estimatedTax).toBeCloseTo(e.estimatedBasis * 0.0123, 6);
    expect(e.estimatedNOI).toBeCloseTo(
      e.estimatedEGI + e.estimatedRecoveries - e.estimatedOpex - e.estimatedTax - e.estimatedReserve,
      6,
    );
  });

  it('taxes a candidate with capital still to spend on its finished basis, not on the standing assessment', () => {
    // An assessment values the property as it stands; the yield being screened
    // is the stabilised one, and the assessor re-bases on completion. Taxing a
    // land-only assessment while measuring yield on full project cost flattered
    // every ground-up deal — the construction-type bias costLoadFactor removes,
    // arriving down a different input path. It also raised confidence, because
    // an assessment was present.
    const development = {
      propertyType: 'multifamily', constructionType: 'groundUp', location: 'Austin, TX',
      units: 80, buildingSize: 72_000, rentPerUnitMonthly: 2_100,
      askingPrice: 1_800_000, capitalBudget: 11_160_000,
      vacancyRate: 5, operatingExpenseRatio: 32,
      assessedValue: 1_800_000,        // the land, which is all there is today
    };
    const r = screenProperty(development);
    expect(r.inputs.taxBaseSource).toBe('basis-proxy');
    expect(r.estimates.estimatedTax)
      .toBeCloseTo(r.estimates.estimatedBasis * (r.inputs.propertyTaxRate / 100), 6);
    // Supplying an assessment the screen cannot use must not buy confidence.
    expect(r.confidence.defaulted).toContain('assessedValue');
    expect(r.confidence.level).not.toBe(CONFIDENCE_CEILING);
    // Without the rule the land assessment would have priced the tax bill.
    expect(r.estimates.estimatedTax).toBeGreaterThan(1_800_000 * 0.05);
  });

  it('taxes a stabilised acquisition on the assessment it actually carries', () => {
    const standing = { ...candidate, capitalBudget: undefined };
    const r = screenProperty(standing);
    expect(r.inputs.taxBaseSource).toBe('assessed');
    expect(r.estimates.estimatedTax).toBeCloseTo(5_000_000 * 0.0123, 6);
    expect(r.confidence.defaulted).not.toContain('assessedValue');
  });

  it('prices FF&E and financing costs into basis when the record carries them', () => {
    // Both are real project cost that finance.js budgets, and neither has an
    // upper bound a screen can assume away: a car wash's tunnel equipment alone
    // moved the estimate 212 bps and out of its published band.
    const withFfe = screenProperty({ ...candidate, ffe: 1_200_000 });
    const withFees = screenProperty({ ...candidate, financingCosts: 400_000 });
    const plain = screenProperty(candidate);
    // FF&E carries contingency (10% on an acquisition) but not the soft load.
    expect(withFfe.estimates.estimatedBasis - plain.estimates.estimatedBasis)
      .toBeCloseTo(1_200_000 * 1.10, 6);
    // Financing costs are a flat budget line and carry neither.
    expect(withFees.estimates.estimatedBasis - plain.estimates.estimatedBasis)
      .toBeCloseTo(400_000, 6);
    expect(withFfe.estimates.estimatedYieldOnCost)
      .toBeLessThan(plain.estimates.estimatedYieldOnCost);
  });

  it('loads soft cost and contingency onto the capital budget, by construction type', () => {
    // Ground-up carries 14% soft cost and 15% contingency; acquisition carries
    // 6% and 10%. Screening a hard-cost budget as if it were a project basis is
    // what made ground-up deals look 165-280 bps better than they were.
    expect(costLoadFactor('groundUp')).toBeCloseTo(1.14 * 1.15, 10);
    expect(costLoadFactor('acquisition')).toBeCloseTo(1.06 * 1.10, 10);

    const groundUp = screenProperty({ ...candidate, constructionType: 'groundUp' });
    const acquisition = screenProperty({ ...candidate, constructionType: 'acquisition' });
    expect(groundUp.estimates.estimatedBasis).toBeGreaterThan(acquisition.estimates.estimatedBasis);
    expect(acquisition.estimates.estimatedBasis)
      .toBeCloseTo(5_200_000 + 1_100_000 * 1.06 * 1.10, 6);
  });

  it('takes an all-in capital budget at face value when the record says so', () => {
    const allIn = screenProperty({ ...candidate, capitalBudgetIsAllIn: true });
    expect(allIn.estimates.estimatedBasis).toBe(6_300_000);
    expect(allIn.inputs.costLoad).toBe(1);
  });

  it('sizes the coverage test on a fully-amortising constant payment', () => {
    const r = screenProperty(candidate);
    expect(r.estimates.estimatedLoanAmount)
      .toBeCloseTo(r.estimates.estimatedBasis * r.inputs.ltv, 6);
    expect(r.estimates.estimatedDSCR)
      .toBeCloseTo(r.estimates.estimatedNOI / r.estimates.estimatedDebtService, 10);
  });

  it('yields a DSCR proportional to yield on cost, because screening leverage is uniform', () => {
    // Not an accident and worth pinning: under one house LTV/rate/term the
    // screening DSCR is yield on cost times a constant, so it tests candidates
    // against the lender's coverage floor but adds no ranking information. If
    // this ever stops holding, someone has made loan sizing candidate-specific
    // and the two screening rankings will have silently diverged.
    const ratios = SAMPLE_DEALS
      .map((d) => screenProperty(screeningCandidateFromDeal(d)).estimates)
      .map((e) => e.estimatedDSCR / e.estimatedYieldOnCost);
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0], 9);
  });
});

describe('unknowns are never zero', () => {
  it('returns null, not zero, when no rent is known', () => {
    const r = screenProperty({ propertyType: 'retail', location: 'Tampa, FL', buildingSize: 18_000, askingPrice: 5_000_000 });
    expect(r.estimates.estimatedGPR).toBeNull();
    expect(r.estimates.estimatedNOI).toBeNull();
    expect(r.estimates.estimatedYieldOnCost).toBeNull();
    expect(r.confidence.missing).toContain('rent');
  });

  it('returns null, not zero, when no price or assessment is known', () => {
    const r = screenProperty({ propertyType: 'retail', location: 'Tampa, FL', buildingSize: 18_000, rentPerSFAnnual: 31 });
    expect(r.estimates.estimatedBasis).toBeNull();
    expect(r.estimates.estimatedTax).toBeNull();
    expect(r.estimates.estimatedDSCR).toBeNull();
    expect(r.confidence.missing).toContain('basis');
  });

  it('refuses an NOI it cannot put a capex reserve into', () => {
    // A reserve-free NOI is a different definition of NOI. Mixing the two
    // inside one ranked batch would order candidates by which fields their feed
    // happened to populate, so the estimate is withheld instead.
    const noSize = screenProperty({
      propertyType: 'carwash', location: 'Houston, TX',
      annualRevenue: 1_500_000, askingPrice: 5_000_000,
    });
    expect(noSize.estimates.estimatedGPR).toBe(1_500_000);
    expect(noSize.estimates.estimatedReserve).toBeNull();
    expect(noSize.estimates.estimatedNOI).toBeNull();
    expect(noSize.confidence.missing).toContain('capexReserveBasis');
  });

  it('falls back to basis for the tax base and says that it did', () => {
    const r = screenProperty({ ...candidate, assessedValue: undefined });
    expect(r.inputs.taxBaseSource).toBe('basis-proxy');
    expect(r.confidence.defaulted).toContain('assessedValue');
    expect(r.estimates.estimatedTax).toBeCloseTo(r.estimates.estimatedBasis * 0.0123, 6);
  });
});

describe('the result cannot be mistaken for an underwritten one', () => {
  const screened = screenProperty(screeningCandidateFromDeal(SAMPLE_DEALS[4]));
  const model = runModel(SAMPLE_DEALS[4]);

  it('shares no metric name with the model, so it cannot be swapped in', () => {
    // The failure mode: a screen estimate rendered by a component that believes
    // it is showing an underwritten figure. Disjoint keys make that render
    // empty rather than plausible.
    const collisions = Object.keys(screened.estimates)
      .filter((k) => k in model.operating || k in model.returns);
    expect(collisions).toEqual([]);
    expect(Object.keys(screened).filter((k) => k in model)).toEqual([]);
  });

  it('carries no schedule and no return that would need one', () => {
    expect(screened.months).toBeUndefined();
    expect(screened.annual).toBeUndefined();
    const keys = JSON.stringify(Object.keys(screened.estimates));
    expect(keys).not.toMatch(/irr/i);
    expect(keys).not.toMatch(/multiple/i);
  });

  it('marks itself as an estimate, mirroring the seed marking on market data', () => {
    expect(screened.tier).toBe('screen');
    expect(screened.provenance.dataQuality).toBe('estimate');
    expect(screened.provenance.underwritten).toBe(false);
    expect(SCREEN_PROVENANCE.source).toMatch(/runModel/);
  });

  it('caps confidence below underwriting however complete the inputs are', () => {
    // Confidence describes the METHOD, not just the record. A perfect candidate
    // still omits everything in SCREEN_OMISSIONS, so no input can lift it.
    // A standing asset, so the assessment it carries is the one it will be
    // taxed on; a candidate with capital still to spend is priced on its
    // finished basis and cannot reach the ceiling on an assessment alone.
    const complete = screenProperty({
      ...candidate, capitalBudget: undefined, propertyTaxRate: 1.23, expenseRecoveryRate: 0.9,
    });
    expect(complete.confidence.defaulted).toEqual([]);
    expect(complete.confidence.malformed).toEqual([]);
    expect(complete.confidence.level).toBe(CONFIDENCE_CEILING);
    expect(complete.confidence.ceiling).toBe(CONFIDENCE_CEILING);
    expect(complete.confidence.underwritten).toBe(false);
    expect(Object.keys(YIELD_BAND_BPS)).not.toContain('high');
  });

  it('degrades confidence as inputs fall back to house defaults', () => {
    const bare = screenProperty({
      propertyType: 'retail', location: 'Nowhere County',
      buildingSize: 18_000, rentPerSFAnnual: 31, askingPrice: 5_200_000,
    });
    expect(bare.confidence.defaulted).toEqual(
      expect.arrayContaining(['vacancyRate', 'operatingExpenseRatio', 'propertyTaxRate', 'assessedValue']),
    );
    expect(bare.confidence.level).toBe('indicative');
    expect(bare.confidence.taxRateBasis).toBe('default');
  });

  it('widens the yield band as confidence falls', () => {
    expect(YIELD_BAND_BPS.indicative).toBeGreaterThan(YIELD_BAND_BPS.low);
    expect(YIELD_BAND_BPS.low).toBeGreaterThan(YIELD_BAND_BPS.moderate);
    const band = screened.estimates.estimatedYieldBand;
    expect(band.low).toBeLessThan(screened.estimates.estimatedYieldOnCost);
    expect(band.high).toBeGreaterThan(screened.estimates.estimatedYieldOnCost);
  });

  it('publishes what it omits, and which way each omission biases the estimate', () => {
    expect(SCREEN_OMISSIONS.length).toBeGreaterThan(0);
    for (const o of SCREEN_OMISSIONS) {
      expect(['high', 'low', 'none']).toContain(o.screenBias);
      expect(o.detail).toEqual(expect.any(String));
    }
    expect(SCREEN_OMISSIONS.map((o) => o.key)).toContain('exit');
  });
});

describe('one pass of arithmetic per candidate', () => {
  it('does not depend on the hold period, because there is no schedule to hold', () => {
    // The structural proof that no time dimension crept in: a screen of the
    // same asset over a 5-year and a 30-year hold is the same screen.
    const short = screenProperty({ ...candidate, holdPeriod: 5 });
    const long = screenProperty({ ...candidate, holdPeriod: 30 });
    expect(long.estimates).toEqual(short.estimates);
  });

  it('screens thousands of candidates in the time the model takes on a handful', () => {
    // A tier that cannot clear a night's sourcing feed is not a screening tier.
    // The bound is deliberately loose — this is guarding against a monthly loop
    // or an IRR solve reappearing, not micro-benchmarking.
    const batch = Array.from({ length: 5000 }, (_, i) => ({ ...candidate, askingPrice: 5_000_000 + i * 1000 }));
    const t0 = Date.now();
    const ranked = screenAll(batch);
    const elapsed = Date.now() - t0;
    expect(ranked).toHaveLength(5000);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('screenAll ranking', () => {
  it('ranks by estimated yield on cost, best first', () => {
    const ranked = screenAll(SAMPLE_DEALS.map(screeningCandidateFromDeal));
    const yields = ranked.map((r) => r.estimates.estimatedYieldOnCost);
    expect(yields).toEqual([...yields].sort((a, b) => b - a));
    expect(ranked.map((r) => r.rank)).toEqual(ranked.map((_, i) => i + 1));
  });

  it('leaves an unpriceable candidate unranked rather than ranking it last', () => {
    // Sorting a null yield as zero buries a property whose only defect is a
    // gap in the feed — the same recall failure as rejecting it outright.
    const ranked = screenAll([
      { propertyType: 'retail', location: 'Tampa, FL', buildingSize: 18_000, askingPrice: 5_000_000 },
      candidate,
    ]);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBeNull();
    expect(ranked[1].estimates.estimatedYieldOnCost).toBeNull();
  });

  it('is stable, so re-screening an unchanged batch cannot reshuffle a shortlist', () => {
    const tied = [
      { ...candidate, id: 'a' }, { ...candidate, id: 'b' }, { ...candidate, id: 'c' },
    ];
    expect(screenAll(tied).map((r) => r.candidate.id)).toEqual(['a', 'b', 'c']);
  });
});

/**
 * DIRECTIONAL AGREEMENT WITH THE FULL MODEL
 *
 * The screen and the model must not disagree about which deals are worth
 * underwriting. They will disagree about the numbers, and the divergence is
 * expected, one-directional and explained by SCREEN_OMISSIONS:
 *
 *   - Basis omits FF&E, financing costs and the capitalised construction
 *     interest reserve, which flatters the screen.
 *   - Revenue and expenses are held in today's dollars, while the model reads
 *     its stabilised year after construction and lease-up, when both have
 *     escalated. Rent grows faster than the tax assessment does, so this
 *     understates the screen.
 *
 * Across the sample portfolio the second effect dominates and the screen lands
 * 4-74 bps BELOW the model on every deal. That is a residual SPREAD of about
 * 70 bps, which is what bounds the rank invariants below: a pair separated by
 * more than the spread cannot invert, and a pair inside it is a tie the screen
 * is not entitled to resolve.
 */
describe('inputs the feed gets wrong', () => {
  it('refuses to price a candidate whose property type it does not recognise', () => {
    // Not a missing field but a category error: revenue basis, expense load,
    // recovery rate and reserve convention all hang off the type. Screened as a
    // car wash, a warehouse read 444 bps off its industrial figure — and did so
    // at the top of the confidence scale with the narrowest band, because
    // nothing recorded the substitution. It ranks null instead: unpriceable
    // keeps the candidate in the batch, priced-as-something-else does not.
    const warehouse = {
      propertyType: 'warehouse', constructionType: 'groundUp', location: 'Houston, TX',
      buildingSize: 642_000, rentPerSFAnnual: 11.25, askingPrice: 8_000_000,
      capitalBudget: 61_000_000, vacancyRate: 5, operatingExpenseRatio: 25,
      assessedValue: 88_000_000,
    };
    const r = screenProperty(warehouse);
    expect(r.confidence.missing).toContain('propertyType');
    expect(r.confidence.level).toBe('insufficient');
    expect(r.estimates.estimatedNOI).toBeNull();
    expect(r.estimates.estimatedYieldOnCost).toBeNull();
    expect(r.estimates.estimatedYieldBand).toBeNull();

    // Same for a record with no property type at all.
    const untyped = screenProperty({ ...warehouse, propertyType: undefined });
    expect(untyped.confidence.missing).toContain('propertyType');
    expect(untyped.estimatedYieldOnCost).toBeUndefined();

    // And it stays in the batch rather than being dropped from it.
    const ranked = screenAll([warehouse, { ...warehouse, propertyType: 'industrial' }]);
    expect(ranked).toHaveLength(2);
    expect(ranked.find((x) => x.candidate.propertyType === 'warehouse').rank).toBeNull();
  });

  it('records a value it could not read rather than treating it as absent', () => {
    // A CSV or JSON feed hands over '5200000'. Rejected silently, the price
    // vanished and the basis quietly became the tax assessment instead — a
    // different definition, 227 bps of yield, and an empty `missing` list.
    const strings = screenProperty({
      propertyType: 'retail', constructionType: 'acquisition', location: 'Tampa, FL',
      buildingSize: 18_000, rentPerSFAnnual: 31,
      askingPrice: '5200000', capitalBudget: '1100000',
      vacancyRate: 6, operatingExpenseRatio: 20, assessedValue: 5_000_000,
    });
    expect(strings.confidence.malformed).toEqual(
      expect.arrayContaining(['askingPrice', 'capitalBudget']),
    );
    expect(strings.confidence.level).not.toBe(CONFIDENCE_CEILING);
  });

  it('reports a basis of zero as unknown, not as a free building', () => {
    // Zero is not a price. Published, it produced a zero tax bill, a zero loan
    // and a zero coverage test, every one of them reading as a measured answer.
    const free = screenProperty({
      propertyType: 'retail', constructionType: 'acquisition', location: 'Tampa, FL',
      buildingSize: 18_000, rentPerSFAnnual: 31, askingPrice: 0, capitalBudget: 0,
      vacancyRate: 6, operatingExpenseRatio: 20,
    });
    expect(free.confidence.missing).toContain('basis');
    expect(free.estimates.estimatedBasis).toBeNull();
    expect(free.estimates.estimatedTax).toBeNull();
    expect(free.estimates.estimatedLoanAmount).toBeNull();
    expect(free.estimates.estimatedDebtService).toBeNull();
    expect(free.estimates.estimatedNOI).toBeNull();
  });

  it('records the recovery rate as defaulted, since on a net lease it sets the NOI', () => {
    // The largest single NOI lever on an NNN asset, and the only assumption the
    // screen used to substitute without saying so: 0.90 against 0 is 217 bps on
    // this candidate, published at the confidence ceiling either way.
    const silent = screenProperty(candidate);
    expect(silent.confidence.defaulted).toContain('expenseRecoveryRate');
    const stated = screenProperty({ ...candidate, expenseRecoveryRate: 0 });
    expect(stated.confidence.defaulted).not.toContain('expenseRecoveryRate');
    expect(stated.estimates.estimatedYieldOnCost)
      .toBeLessThan(silent.estimates.estimatedYieldOnCost);
  });

  it('floors occupancy as finance.js does rather than dividing by an empty building', () => {
    const impossible = screenProperty({ ...candidate, vacancyRate: 120 });
    expect(impossible.inputs.occupancy).toBe(0.01);
    expect(Number.isFinite(impossible.estimates.estimatedNOI)).toBe(true);
  });
});

describe('directional agreement with runModel', () => {
  const SEPARATION_BPS = 100;   // comfortably above the ~70 bps residual spread
  const SHORTLIST = 3;

  const rows = SAMPLE_DEALS.map((deal) => ({
    name: deal.name,
    modelYield: runModel(deal).operating.yieldOnCost,
    screened: screenProperty(screeningCandidateFromDeal(deal)),
  }));

  it('brackets the underwritten yield inside the screen band on every sample deal', () => {
    // The band is the whole apology for a screening number. If the underwritten
    // answer falls outside it, the band is understating the tier's error and
    // the published half-widths are wrong.
    const outside = rows.filter(({ modelYield, screened }) => {
      const band = screened.estimates.estimatedYieldBand;
      return modelYield < band.low || modelYield > band.high;
    });
    expect(outside.map((r) => r.name)).toEqual([]);
  });

  it('never inverts a pair the model separates clearly', () => {
    const inversions = [];
    for (const a of rows) {
      for (const b of rows) {
        const gapBps = (a.modelYield - b.modelYield) * 10000;
        if (gapBps <= SEPARATION_BPS) continue;
        const screenGap = a.screened.estimates.estimatedYieldOnCost - b.screened.estimates.estimatedYieldOnCost;
        if (screenGap <= 0) inversions.push(`${a.name} > ${b.name} by ${gapBps.toFixed(0)}bps in the model, inverted by the screen`);
      }
    }
    expect(inversions).toEqual([]);
  });

  it('puts every deal the model ranks top-3 into the screen top-3', () => {
    // Recall is the promise the tier makes: a deal the screen drops is never
    // underwritten, so a miss here is unrecoverable downstream.
    const byModel = [...rows].sort((a, b) => b.modelYield - a.modelYield).slice(0, SHORTLIST).map((r) => r.name);
    const byScreen = screenAll(SAMPLE_DEALS.map(screeningCandidateFromDeal))
      .slice(0, SHORTLIST)
      .map((r) => r.candidate.name);
    expect(byScreen.slice().sort()).toEqual(byModel.slice().sort());
  });

  it('holds the band when the deal overrides the assumptions the screen would default', () => {
    // The published envelope was an artifact of the sample deals happening not
    // to carry a recovery override, FF&E or loan fees. The bridge dropped all
    // three, so the screen priced house defaults against a model pricing the
    // deal — a recovery override alone put the screen 198 bps HIGH, the
    // dangerous direction, and outside its own band.
    const overrides = [
      { label: 'recovery override', patch: { expenseRecoveryRate: 0.40 } },
      { label: 'FF&E', patch: { ffe: 1_200_000 } },
      { label: 'financing costs', patch: { financingCosts: 400_000 } },
    ];
    const outside = [];
    for (const { label, patch } of overrides) {
      for (const deal of SAMPLE_DEALS) {
        const patched = { ...deal, ...patch };
        const modelYield = runModel(patched).operating.yieldOnCost;
        const band = screenProperty(screeningCandidateFromDeal(patched))
          .estimates.estimatedYieldBand;
        if (modelYield < band.low || modelYield > band.high) outside.push(`${label}: ${deal.name}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('holds the band when the feed omits the assumptions both tiers have to default', () => {
    // Both tiers must fall back to the same house numbers. Resolving vacancy
    // and the expense ratio from firmDefaults on one side and from a constant
    // on the other made the error correlate with property type — 195 bps of
    // spread, no longer one-directional, and the model top-3 lost a deal.
    const stripped = SAMPLE_DEALS.map(({ operatingExpenseRatio, vacancyRate, ...rest }) => rest);
    const diffs = [];
    for (const deal of stripped) {
      const modelYield = runModel(deal).operating.yieldOnCost;
      const screened = screenProperty(screeningCandidateFromDeal(deal));
      const band = screened.estimates.estimatedYieldBand;
      expect(modelYield).toBeGreaterThanOrEqual(band.low);
      expect(modelYield).toBeLessThanOrEqual(band.high);
      diffs.push((screened.estimates.estimatedYieldOnCost - modelYield) * 10000);
    }
    for (const d of diffs) expect(d).toBeLessThanOrEqual(0);
    expect(Math.max(...diffs) - Math.min(...diffs)).toBeLessThan(SEPARATION_BPS);
  });

  it('brackets the underwritten yield at the tightest band the tier can publish', () => {
    // Every sample deal has capital still to spend, so none of them can reach
    // the confidence ceiling and the 75 bps band was never measured against the
    // model at all. A standing asset with a complete record can reach it, and
    // that is the band a well-populated feed actually ships.
    const standing = {
      propertyType: 'office', constructionType: 'acquisition', location: 'Plano, TX',
      purchasePrice: 28_000_000, constructionCost: 0, buildingSize: 210_000,
      grossRevenue: 5_100_000, vacancyRate: 12, operatingExpenseRatio: 30,
      expenseRecoveryRate: 0.55, propertyTaxRate: 2.15,
      downPayment: 35, interestRate: 6.1, loanTerm: 25, exitCapRate: 8.2, holdPeriod: 7,
    };
    const screened = screenProperty({
      ...screeningCandidateFromDeal(standing),
      assessedValue: standing.purchasePrice,
    });
    expect(screened.confidence.level).toBe(CONFIDENCE_CEILING);
    expect(screened.estimates.estimatedYieldBand.halfWidthBps).toBe(YIELD_BAND_BPS.moderate);
    const modelYield = runModel(standing).operating.yieldOnCost;
    expect(modelYield).toBeGreaterThanOrEqual(screened.estimates.estimatedYieldBand.low);
    expect(modelYield).toBeLessThanOrEqual(screened.estimates.estimatedYieldBand.high);
  });

  it('diverges within the documented envelope and in the documented direction', () => {
    const diffs = rows.map(({ modelYield, screened }) =>
      (screened.estimates.estimatedYieldOnCost - modelYield) * 10000);
    // One-directional: the escalation the screen omits outweighs the basis it
    // omits, so the screen is conservative on a deal of this shape. A screen
    // that started flattering deals would be the dangerous failure.
    for (const d of diffs) expect(d).toBeLessThanOrEqual(0);
    expect(Math.max(...diffs) - Math.min(...diffs)).toBeLessThan(SEPARATION_BPS);
  });
});
