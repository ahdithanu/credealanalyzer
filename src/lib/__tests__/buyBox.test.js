import { describe, it, expect } from 'vitest';
import { analyseRentRoll, engineInputsFromRentRoll } from '../rentRoll';
import { evaluate, measure, rank, STRIP_CENTER_BOX } from '../buyBox';

/**
 * The rent roll and the buy box.
 *
 * Organised around the ways a screening layer costs you money, which is not
 * the same as the ways it can be wrong:
 *
 *   1. It passes a deal on a test it never took.
 *   2. It reports an average that hides the thing that breaks the deal.
 *   3. It reads a concentrated roll as diversified.
 *   4. It rejects a deal for a reason that is not true.
 */

/** Pinned so a WALT test does not change answer tomorrow. */
const ASOF = new Date('2026-01-01T00:00:00Z');
const inYears = (y) => new Date(ASOF.getTime() + y * 365.25 * 24 * 3600 * 1000).toISOString();

/** A centre that passes: 9 bays, 14,400 SF, spread tenancy, long WALT. */
function goodRoll() {
  return [
    { tenant: 'Clip Joint',     category: 'salon',        squareFeet: 1600, baseRentAnnual: 33600, leaseEnd: inYears(4.2), recovery: 'nnn', marketRentPSF: 22 },
    { tenant: 'Valley Dental',  category: 'medical',      squareFeet: 2000, baseRentAnnual: 44000, leaseEnd: inYears(6.0), recovery: 'nnn', marketRentPSF: 23 },
    { tenant: 'H&R Tax',        category: 'professional', squareFeet: 1400, baseRentAnnual: 28000, leaseEnd: inYears(3.1), recovery: 'nnn', marketRentPSF: 21 },
    { tenant: 'Iron Yard Gym',  category: 'fitness',      squareFeet: 2400, baseRentAnnual: 40800, leaseEnd: inYears(5.5), recovery: 'nnn', marketRentPSF: 18 },
    { tenant: 'Taco Rapido',    category: 'qsr',          squareFeet: 1600, baseRentAnnual: 36800, leaseEnd: inYears(3.8), recovery: 'nnn', marketRentPSF: 24 },
    { tenant: 'State Farm',     category: 'professional', squareFeet: 1200, baseRentAnnual: 25200, leaseEnd: inYears(4.5), recovery: 'nnn', marketRentPSF: 22 },
    { tenant: 'Nails & Co',     category: 'salon',        squareFeet: 1400, baseRentAnnual: 29400, leaseEnd: inYears(3.4), recovery: 'nnn', marketRentPSF: 22 },
    { tenant: 'UrgentMed',      category: 'urgentCare',   squareFeet: 1600, baseRentAnnual: 36800, leaseEnd: inYears(7.0), recovery: 'nnn', marketRentPSF: 24 },
    { vacant: true, category: 'vacant',                   squareFeet: 1200 },
  ];
}

const goodDeal = (over = {}) => ({
  name: 'Maple Crossing',
  propertyType: 'retail',
  purchasePrice: 2_400_000,
  yearBuilt: 1998,
  trafficCount: 22000,
  parkingSpaces: 72,
  popGrowth3mi: 1.4,
  rentRoll: goodRoll(),
  ...over,
});

// ─── 1. A deal cannot pass a test it did not take ────────────────────────────

describe('unknown is a third state, not a pass', () => {
  it('a deal with no rent roll is incomplete, never a pass', () => {
    const r = evaluate({
      propertyType: 'retail', purchasePrice: 2_400_000, buildingSize: 14_400,
      yearBuilt: 1998, trafficCount: 22000, parkingSpaces: 72, popGrowth3mi: 1.4,
    }, STRIP_CENTER_BOX.key, { asOf: ASOF });

    // Everything on the header checks out. None of the lease questions was asked.
    expect(r.verdict).toBe('incomplete');
    expect(r.unknown).toBeGreaterThan(0);
    expect(r.missing).toContain('largestTenantShare');
    expect(r.missing).toContain('waltYears');
  });

  it('the hard unknowns are listed before the soft ones', () => {
    const r = evaluate({ propertyType: 'retail', purchasePrice: 2_400_000 },
      STRIP_CENTER_BOX.key, { asOf: ASOF });
    const first = STRIP_CENTER_BOX.criteria.find((c) => c.key === r.missing[0]);
    expect(first.severity).toBe('hard');
  });

  it('a complete, compliant deal passes', () => {
    const r = evaluate(goodDeal(), STRIP_CENTER_BOX.key, { asOf: ASOF });
    expect(r.verdict).toBe('pass');
    expect(r.unknown).toBe(0);
    expect(r.failed).toBe(0);
  });
});

// ─── 2. Averages that hide the thing that breaks the deal ────────────────────

describe('WALT does not hide a rollover cliff', () => {
  it('reports the year-by-year expiry behind the average', () => {
    // A 3.4-year WALT that is comfortable until you see that 55% of it lands
    // inside 24 months. This is the case an average cannot show, which is why
    // rolloverByYear exists beside it.
    const roll = [
      { tenant: 'A', category: 'salon',  squareFeet: 2000, baseRentAnnual: 50000, leaseEnd: inYears(1.5), recovery: 'nnn' },
      { tenant: 'B', category: 'medical', squareFeet: 2000, baseRentAnnual: 50000, leaseEnd: inYears(1.8), recovery: 'nnn' },
      { tenant: 'C', category: 'fitness', squareFeet: 2000, baseRentAnnual: 40000, leaseEnd: inYears(6.5), recovery: 'nnn' },
      { tenant: 'D', category: 'qsr',     squareFeet: 2000, baseRentAnnual: 40000, leaseEnd: inYears(6.5), recovery: 'nnn' },
    ];
    const r = analyseRentRoll(roll, { asOf: ASOF });
    expect(r.waltYears).toBeGreaterThan(3);              // looks fine
    const soon = r.rolloverByYear[0].shareOfRentPct + r.rolloverByYear[1].shareOfRentPct;
    expect(soon).toBeCloseTo(55.6, 0);                   // and it is not
  });

  it('WALT says what share of the rent it was computed over', () => {
    // A 5-year WALT derived from one lease out of six is not a 5-year WALT, and
    // the coverage figure is the only thing that says so.
    const roll = [
      { tenant: 'A', squareFeet: 2000, baseRentAnnual: 20000, leaseEnd: inYears(5) },
      { tenant: 'B', squareFeet: 2000, baseRentAnnual: 60000 },
    ];
    const r = analyseRentRoll(roll, { asOf: ASOF });
    expect(r.waltYears).toBeCloseTo(5, 5);
    expect(r.waltCoverageOfRentPct).toBeCloseTo(25, 5);
  });

  it('an expired lease contributes zero, not a negative', () => {
    // A holdover is still paying. Letting it subtract would make a roll of
    // holdovers score worse than a roll of vacancies, which is backwards.
    const roll = [
      { tenant: 'Holdover', squareFeet: 1000, baseRentAnnual: 20000, leaseEnd: inYears(-2) },
      { tenant: 'Good',     squareFeet: 1000, baseRentAnnual: 20000, leaseEnd: inYears(4) },
    ];
    const r = analyseRentRoll(roll, { asOf: ASOF });
    expect(r.waltYears).toBeCloseTo(2, 5);
    // And it is surfaced separately rather than lost inside the average.
    expect(r.holdoverSharePct).toBeCloseTo(50, 5);
  });
});

// ─── 3. Concentration, read correctly ────────────────────────────────────────

describe('concentration is measured per operator, not per bay', () => {
  it('three bays held by one tenant count once', () => {
    // The arithmetic that makes a concentrated centre look diversified: split
    // one tenant across three leases and every per-bay share drops under 30%.
    const roll = [
      { tenant: 'Dollar General', category: 'generalRetail', squareFeet: 2400, baseRentAnnual: 24000 },
      { tenant: 'Dollar General', category: 'generalRetail', squareFeet: 2400, baseRentAnnual: 24000 },
      { tenant: 'Dollar General', category: 'generalRetail', squareFeet: 2400, baseRentAnnual: 24000 },
      { tenant: 'Nails',          category: 'salon',         squareFeet: 1200, baseRentAnnual: 14000 },
      { tenant: 'Barber',         category: 'salon',         squareFeet: 1200, baseRentAnnual: 14000 },
    ];
    const r = analyseRentRoll(roll, { asOf: ASOF });
    expect(r.tenants[0].tenant).toBe('Dollar General');
    expect(r.tenants[0].bays).toBe(3);
    // 72,000 of 100,000. Each individual bay is 24%, which would have passed.
    expect(r.largestTenantShare).toBeCloseTo(72, 5);
  });

  it('a concentrated centre fails the box on a hard rule', () => {
    const roll = goodRoll();
    roll[1].baseRentAnnual = 200_000;      // Valley Dental becomes most of the rent
    const r = evaluate(goodDeal({ rentRoll: roll }), STRIP_CENTER_BOX.key, { asOf: ASOF });
    expect(r.verdict).toBe('fail');
    expect(r.hardFailures.map((f) => f.key)).toContain('largestTenantShare');
    // The failure carries the number, which is the part anyone reads.
    const f = r.results.find((x) => x.key === 'largestTenantShare');
    expect(f.display).toMatch(/%$/);
    expect(f.threshold).toBe('at most 30.0%');
  });
});

// ─── 4. Rejections that are not true ─────────────────────────────────────────

describe('measurements are conventional, so verdicts are not wrong for the wrong reason', () => {
  it('occupancy is by area, not by bay count', () => {
    // Five small let bays and one large empty one is half empty. Counting bays
    // would call it 83% occupied and pass an 80% floor it should fail.
    const roll = [
      ...Array.from({ length: 5 }, (_, i) => ({
        tenant: `T${i}`, squareFeet: 1200, baseRentAnnual: 24000,
      })),
      { vacant: true, squareFeet: 6000 },
    ];
    const r = analyseRentRoll(roll, { asOf: ASOF });
    expect(r.occupancyPct).toBeCloseTo(50, 5);
  });

  it('rent per SF is quoted on leased area, not total', () => {
    // Dividing by total area blends vacancy into the rate and produces a number
    // that matches no lease in the building and no comp in the market.
    const roll = [
      { tenant: 'A', squareFeet: 1000, baseRentAnnual: 20000 },
      { vacant: true, squareFeet: 1000 },
    ];
    const r = analyseRentRoll(roll, { asOf: ASOF });
    expect(r.inPlaceRentPSF).toBeCloseTo(20, 5);   // not 10
  });

  it('above-market rent is flagged, and only over the bays that have a market view', () => {
    const roll = [
      { tenant: 'A', squareFeet: 1000, baseRentAnnual: 30000, marketRentPSF: 24 },
      { tenant: 'B', squareFeet: 1000, baseRentAnnual: 20000 },   // no market view
    ];
    const r = analyseRentRoll(roll, { asOf: ASOF });
    // 30,000 in place against 24,000 at market = 25% over, on the half of the
    // roll that could be measured.
    expect(r.rentVsMarketPct).toBeCloseTo(25, 5);
    expect(r.marketCoverageOfRentPct).toBeCloseTo(60, 5);
  });

  it('price per SF is tested independently of total price', () => {
    // The two ranges do not line up at the corners. 24,000 SF at $3.9M is
    // inside the price range and $162/SF — both fine. The same $3.9M on
    // 12,000 SF is $325/SF and has to fail on rate alone.
    const wide = evaluate(goodDeal({
      purchasePrice: 3_900_000, rentRoll: null, buildingSize: 24_000,
    }), STRIP_CENTER_BOX.key, { asOf: ASOF });
    expect(wide.results.find((r) => r.key === 'pricePSF').status).toBe('pass');

    const narrow = evaluate(goodDeal({
      purchasePrice: 3_900_000, rentRoll: null, buildingSize: 12_000,
    }), STRIP_CENTER_BOX.key, { asOf: ASOF });
    expect(narrow.results.find((r) => r.key === 'price').status).toBe('pass');
    expect(narrow.results.find((r) => r.key === 'pricePSF').status).toBe('fail');
    expect(narrow.verdict).toBe('fail');
  });

  it('a soft failure is review, not fail', () => {
    // 28% restaurants is a conversation. Outside the price range is not.
    const roll = goodRoll();
    roll[4].category = 'restaurant';
    // 25% of the OTHER rent divided by 75% is the break-even; 79,267 is the
    // threshold on this roll, so 90,000 lands clearly past it at 27.5%.
    roll[4].baseRentAnnual = 90_000;
    const r = evaluate(goodDeal({ rentRoll: roll }), STRIP_CENTER_BOX.key, { asOf: ASOF });
    expect(r.results.find((x) => x.key === 'restaurantSharePct').status).toBe('fail');
    expect(r.hardFailures).toHaveLength(0);
    expect(r.verdict).toBe('review');
  });
});

// ─── The rent roll is the primary document ───────────────────────────────────

describe('the rent roll overrides the header figures', () => {
  it('building size comes from the bays when they disagree', () => {
    // The header is somebody's summary of the roll. When they differ, the
    // summary is the one that is wrong.
    const m = measure(goodDeal({ buildingSize: 30_000 }), { asOf: ASOF });
    expect(m.buildingSize).toBe(14_400);
  });

  it('engine inputs come out in the shape runModel expects', () => {
    const inputs = engineInputsFromRentRoll(goodRoll(), { asOf: ASOF });
    expect(inputs.buildingSize).toBe(14_400);
    // Gross POTENTIAL — the leased rate applied across the WHOLE building, so
    // the engine's own vacancy factor is not applied on top of a rate that
    // already has the vacancy in it. Asserted as the relationship rather than
    // a copied constant, which is a way of asserting a typo.
    const roll = analyseRentRoll(goodRoll(), { asOf: ASOF });
    expect(inputs.grossRevenue).toBeCloseTo(roll.inPlaceRentPSF * roll.totalSF, 6);
    expect(inputs.grossRevenue).toBeGreaterThan(roll.grossBaseRent);
    expect(inputs.vacancyRate).toBeCloseTo(8.33, 1);
    expect(inputs.expenseRecoveryRate).toBe(1);   // every lease is NNN
  });

  it('a half-gross roll does not claim full recovery', () => {
    const roll = goodRoll().map((b, i) => (i < 4 ? { ...b, recovery: 'gross' } : b));
    const inputs = engineInputsFromRentRoll(roll, { asOf: ASOF });
    // The property-type default for retail is 0.90. The leases say otherwise.
    expect(inputs.expenseRecoveryRate).toBeLessThan(0.7);
  });
});

// ─── Ranking ─────────────────────────────────────────────────────────────────

describe('ranking a shortlist', () => {
  it('orders pass, review, incomplete, fail', () => {
    const ranked = rank([
      { name: 'priced out', propertyType: 'retail', purchasePrice: 9_000_000, buildingSize: 14_400 },
      goodDeal({ name: 'clean' }),
      { name: 'unknown', propertyType: 'retail', purchasePrice: 2_400_000 },
    ], STRIP_CENTER_BOX.key, { asOf: ASOF });

    expect(ranked.map((r) => r.deal.name)).toEqual(['clean', 'unknown', 'priced out']);
    expect(ranked.map((r) => r.verdict)).toEqual(['pass', 'incomplete', 'fail']);
  });

  it('among incomplete deals, the better-known one ranks first', () => {
    // The shortlist orders by what is known, and `missing` says what to find out.
    const sparse = { name: 'sparse', propertyType: 'retail', purchasePrice: 2_400_000 };
    const fuller = {
      name: 'fuller', propertyType: 'retail', purchasePrice: 2_400_000,
      buildingSize: 14_400, yearBuilt: 1998, trafficCount: 22000, parkingSpaces: 72,
    };
    const ranked = rank([sparse, fuller], STRIP_CENTER_BOX.key, { asOf: ASOF });
    expect(ranked[0].deal.name).toBe('fuller');
    expect(ranked[0].passed).toBeGreaterThan(ranked[1].passed);
  });
});

// ─── Degenerate inputs ───────────────────────────────────────────────────────

describe('nothing invents a number', () => {
  it('an empty roll reports null, not zero', () => {
    const r = analyseRentRoll([], { asOf: ASOF });
    // A WALT of 0 would mean every lease has expired. Null means nobody typed
    // the dates, and those must not look alike.
    expect(r.waltYears).toBeNull();
    expect(r.grossBaseRent).toBeNull();
    expect(r.occupancyPct).toBeNull();
    expect(r.largestTenantShare).toBeNull();
  });

  it('malformed figures do not become zeroes', () => {
    const r = analyseRentRoll([
      { tenant: 'A', squareFeet: 'not a number', baseRentAnnual: 20000 },
    ], { asOf: ASOF });
    expect(r.totalSF).toBeNull();
    expect(r.grossBaseRent).toBe(20000);
  });

  it('engine inputs are null rather than partial when the roll cannot support them', () => {
    expect(engineInputsFromRentRoll([], { asOf: ASOF })).toBeNull();
  });

  it('an unknown box is an error, not a default', () => {
    expect(() => evaluate(goodDeal(), 'not-a-box')).toThrow(/unknown buy box/);
  });
});
