import {
  DEFAULT_WATERFALL,
  periodRate,
  resolveWaterfall,
  runWaterfall,
  waterfallFromModel,
  promoteState,
} from '../waterfall';
import { runModel, irr, annualize } from '../finance';
import { SAMPLE_DEALS } from '../sampleDeals';

/**
 * Every expected figure below is hand-computed from the tier definitions, and
 * the derivation is written out above the assertion. Where a test asserts an
 * output of the module against another output of the module it is asserting a
 * conservation law, never a value.
 *
 * The annual-period harness (periodsPerYear: 1) exists so the pref and hurdle
 * accruals are powers of 1.08 and 1.15 that can be checked by hand. The monthly
 * behaviour is exercised separately against runModel().
 */
const ANNUAL = {
  periodsPerYear: 1,
  prefRate: 0.08,
  catchUp: { enabled: false },
  tiers: [{ irrHurdle: null, gpShare: 0.20 }],
};

/** Sum a per-period field across the whole waterfall. */
const total = (result, key) => result.periods.reduce((s, p) => s + p[key], 0);

describe('periodRate', () => {
  it('treats a stated rate as an effective annual rate by default', () => {
    // (1 + r)^12 must reproduce the stated 8% exactly, not 8.30%.
    const r = periodRate(0.08, 12);
    expect(Math.pow(1 + r, 12) - 1).toBeCloseTo(0.08, 12);
  });

  it('divides instead when the deal documents quote a nominal rate', () => {
    expect(periodRate(0.08, 12, 'nominal')).toBeCloseTo(0.08 / 12, 12);
    // The two bases are not interchangeable: nominal monthly compounding on an
    // 8% pref yields 8.30% a year. A waterfall that silently picked one is
    // giving away 30 bps of LP money a year.
    expect(Math.pow(1 + 0.08 / 12, 12) - 1).toBeCloseTo(0.0829995, 6);
  });

  it('is zero for a zero rate rather than NaN', () => {
    expect(periodRate(0, 12)).toBe(0);
  });
});

describe('pref accrual convention', () => {
  it('compounds unpaid pref on unreturned capital', () => {
    // $1,000 called at t=0, nothing distributed until t=4.
    // Accrual runs at the start of each period after time zero, so four
    // accruals: 1,000 x 1.08^4 = 1,360.48896, i.e. $360.48896 of pref.
    // Distribution of $2,000 at t=4 then pays:
    //   pref            360.48896
    //   return of cap  1000.00000   -> residual 639.51104
    //   80/20 split     GP 127.902208 / LP 511.608832
    //   LP total       1872.097792
    const r = runWaterfall([-1000, 0, 0, 0, 2000], ANNUAL);
    const last = r.periods[4];

    expect(last.prefPaid).toBeCloseTo(360.48896, 8);
    expect(last.capitalReturned).toBeCloseTo(1000, 8);
    expect(last.gpPromote).toBeCloseTo(127.902208, 8);
    expect(last.lpDistribution).toBeCloseTo(1872.097792, 8);
    expect(r.totals.unpaidPref).toBeCloseTo(0, 9);
    expect(r.totals.unreturnedCapital).toBeCloseTo(0, 9);
  });

  it('accrues simple pref only on unreturned capital when compounding is off', () => {
    // Three accruals of 1,000 x 8% = 240 flat, against 1.08^3 - 1 = 259.712
    // compounded. The $19.712 gap is the whole difference between the two
    // conventions and is why the convention has to be stated, not assumed.
    const simple = runWaterfall([-1000, 0, 0, 2000], { ...ANNUAL, prefCompounding: false });
    const compound = runWaterfall([-1000, 0, 0, 2000], ANNUAL);

    expect(simple.periods[3].prefPaid).toBeCloseTo(240, 9);
    expect(compound.periods[3].prefPaid).toBeCloseTo(259.712, 9);
    expect(compound.periods[3].prefPaid - simple.periods[3].prefPaid).toBeCloseTo(19.712, 9);

    // Every extra dollar of pref is a dollar out of the residual, of which the
    // LP was getting 80c. So the LP nets 20c on the dollar: 19.712 x 0.20.
    expect(compound.totals.lpDistributions - simple.totals.lpDistributions).toBeCloseTo(3.9424, 9);
    expect(simple.totals.lpDistributions).toBeCloseTo(1848, 9);
    expect(compound.totals.lpDistributions).toBeCloseTo(1851.9424, 9);
  });

  it('stops accruing pref on capital that has been returned', () => {
    // $1,000 in at t=0; $1,080 back at t=1 clears the full 8% pref ($80) and
    // all $1,000 of capital, leaving nothing outstanding. If pref kept running
    // on CONTRIBUTED capital, t=2 would show a further $80 of accrual and the
    // $500 at t=2 would be split 80/20 on only $420.
    const r = runWaterfall([-1000, 1080, 500], ANNUAL);

    expect(r.periods[1].prefPaid).toBeCloseTo(80, 9);
    expect(r.periods[1].capitalReturned).toBeCloseTo(1000, 9);
    expect(r.periods[2].prefPaid).toBeCloseTo(0, 9);
    expect(r.periods[2].gpPromote).toBeCloseTo(100, 9);   // 20% of the full $500
    expect(r.periods[2].lpDistribution).toBeCloseTo(400, 9);
  });

  it('accrues nothing after the final period', () => {
    // $1,000 in, $400 back at t=3. The $400 covers all 259.712 of accrued pref
    // and 140.288 of capital, so the pref balance is zero at the sale. Accruing
    // at period END instead of period START would add one more period of pref
    // on the $859.712 still outstanding (+$68.78) after the deal is over, and
    // the LP would be shown owed money for time that never elapsed.
    const r = runWaterfall([-1000, 0, 0, 400], ANNUAL);
    expect(r.totals.unreturnedCapital).toBeCloseTo(859.712, 9);
    expect(r.totals.unpaidPref).toBe(0);
    expect(r.returns.prefShortfall).toBe(0);
  });

  it('accrues a simple pref at the stated rate over twelve monthly periods', () => {
    // A simple pref sums; it does not compound. The compounding conversion
    // therefore accrues only 12 x ((1.08)^(1/12) - 1) x 1,000 = 77.21 on a
    // stated 8%, and the shortfall is silently in the GP's favour. Both bases
    // must give the stated rate here, because with no compounding there is no
    // difference between them to quote.
    const flows = [-1000, ...Array(11).fill(0), 5000];
    for (const prefRateBasis of ['effective', 'nominal']) {
      const r = runWaterfall(flows, {
        prefRate: 0.08, prefCompounding: false, prefRateBasis, catchUp: { enabled: false },
      });
      expect(r.periods[12].prefPaid).toBeCloseTo(80, 9);
    }
    // The compounding conventions still differ from each other, as they must.
    expect(runWaterfall(flows, { prefRate: 0.08, catchUp: { enabled: false } })
      .periods[12].prefPaid).toBeCloseTo(80, 9);
  });

  it('accrues the stated rate as a true annual rate over twelve monthly periods', () => {
    // This is the whole reason prefRateBasis defaults to 'effective'. $1,000
    // called at t=0 and held twelve monthly periods must accrue exactly $80 of
    // 8% pref, not the $82.9995 that 8%/12 compounded monthly produces.
    const flows = [-1000, ...Array(11).fill(0), 5000];

    const effective = runWaterfall(flows, { prefRate: 0.08, catchUp: { enabled: false } });
    expect(effective.periods[12].prefPaid).toBeCloseTo(80, 9);

    const nominal = runWaterfall(flows, {
      prefRate: 0.08,
      prefRateBasis: 'nominal',
      catchUp: { enabled: false },
    });
    expect(nominal.periods[12].prefPaid).toBeCloseTo(82.9995, 4);

    // 30 bps a year of LP money rides on which of these the deal documents say.
    expect(nominal.periods[12].prefPaid - effective.periods[12].prefPaid)
      .toBeCloseTo(2.9995, 4);
  });
});

describe('GP catch-up', () => {
  it('a 100% catch-up leaves the GP with exactly the promote share of profit', () => {
    // $1,000 in, $2,000 out at t=2. Pref = 1,000 x (1.08^2 - 1) = 166.40.
    // Catch-up target: promote / (pref + catch-up) = 20%
    //   => catch-up = 166.40 x 0.20/0.80 = 41.60, all of it to the GP.
    // Residual = 2,000 - 166.40 - 1,000 - 41.60 = 792.00 -> GP 158.40 / LP 633.60.
    // GP total 41.60 + 158.40 = 200.00 = 20% of the $1,000 of profit.
    const r = runWaterfall([-1000, 0, 2000], {
      ...ANNUAL,
      catchUp: { enabled: true, gpShare: 1.0 },
    });
    const last = r.periods[2];

    expect(last.prefPaid).toBeCloseTo(166.4, 9);
    expect(last.catchUpPaid).toBeCloseTo(41.6, 9);
    expect(last.gpPromote).toBeCloseTo(200, 9);
    expect(last.lpDistribution).toBeCloseTo(1800, 9);
    expect(r.returns.gpPromoteShareOfProfit).toBeCloseTo(0.20, 12);
  });

  it('a 50/50 catch-up reaches the same end state through a larger gross amount', () => {
    // With the GP taking only half of each catch-up dollar, the LP's half is
    // itself profit and pushes the target up, so the gross required solves
    //   G + 0.5g = 0.25 (P + 0.5g)  with P = 166.40, G = 0
    //   g = 41.60 / (0.5 - 0.25 x 0.5) = 41.60 / 0.375 = 110.933333...
    // GP 55.466667 / LP 55.466667. Residual = 833.60 - 110.933333 = 722.666667
    //   -> GP 144.533333 / LP 578.133333.
    // GP total 200.00 again: the split of catch-up dollars changes the path,
    // not the destination, once there is enough profit to complete it.
    const r = runWaterfall([-1000, 0, 2000], {
      ...ANNUAL,
      catchUp: { enabled: true, gpShare: 0.5 },
    });
    const last = r.periods[2];

    expect(last.catchUpPaid).toBeCloseTo(55.4666666667, 8);
    expect(last.gpPromote).toBeCloseTo(200, 8);
    expect(last.lpDistribution).toBeCloseTo(1800, 8);
  });

  it('does not run a catch-up before pref and capital are paid', () => {
    // $1,100 only covers 259.712 of pref and 840.288 of the $1,000 of capital.
    const r = runWaterfall([-1000, 0, 0, 1100], {
      ...ANNUAL,
      catchUp: { enabled: true, gpShare: 1.0 },
    });
    const last = r.periods[3];

    expect(last.prefPaid).toBeCloseTo(259.712, 9);
    expect(last.capitalReturned).toBeCloseTo(840.288, 9);
    expect(last.catchUpPaid).toBe(0);
    expect(last.gpPromote).toBe(0);
    expect(r.totals.unreturnedCapital).toBeCloseTo(159.712, 9);
  });

  it('catches up only partially when profit runs out mid-tier', () => {
    // Pref 166.40, capital 1,000, leaving 33.60 of the $1,200 for catch-up.
    // The full catch-up would be 41.60, so the GP takes all 33.60 and stops:
    // 33.60 / (166.40 + 33.60) = 16.8% of profit, short of the 20% target, and
    // no residual tier is reached at all.
    const r = runWaterfall([-1000, 0, 1200], {
      ...ANNUAL,
      catchUp: { enabled: true, gpShare: 1.0 },
    });
    const last = r.periods[2];

    expect(last.catchUpPaid).toBeCloseTo(33.6, 9);
    expect(last.residualPaid).toBeCloseTo(0, 9);
    expect(r.returns.gpPromoteShareOfProfit).toBeCloseTo(0.168, 9);
  });
});

describe('IRR hurdle tiers', () => {
  const TIERED = {
    ...ANNUAL,
    tiers: [
      { irrHurdle: 0.15, gpShare: 0.20 },
      { irrHurdle: null, gpShare: 0.40 },
    ],
  };

  it('promotes at the higher rate only above the hurdle, and crosses it mid-period', () => {
    // $1,000 in at t=0, $3,000 out at t=3.
    //   pref            1,000 x (1.08^3 - 1) =   259.712
    //   return of cap                          1,000.000
    //   15% hurdle FV   1,000 x 1.15^3       = 1,520.875, of which the LP has
    //                   already received 1,259.712, leaving 261.163 to go.
    //   tier 1 gross    261.163 / 0.80       =   326.45375  (GP 65.29075)
    //   tier 2 gross    3,000 - 259.712 - 1,000 - 326.45375 = 1,413.83425
    //                   -> GP 565.53370 / LP 848.30055
    //   LP total 259.712 + 1,000 + 261.163 + 848.30055 = 2,369.17555
    //   GP total 65.29075 + 565.53370 = 630.82445
    const r = runWaterfall([-1000, 0, 0, 3000], TIERED);
    const last = r.periods[3];

    expect(last.residualByTier[0]).toBeCloseTo(326.45375, 8);
    expect(last.residualByTier[1]).toBeCloseTo(1413.83425, 8);
    expect(last.gpPromote).toBeCloseTo(630.82445, 8);
    expect(last.lpDistribution).toBeCloseTo(2369.17555, 8);

    // The point of the hurdle: the LP's cumulative receipts at the moment
    // tier 1 is exhausted equal the future value of its capital at 15%.
    expect(last.prefPaid + last.capitalReturned + last.residualByTier[0] * 0.8)
      .toBeCloseTo(1000 * Math.pow(1.15, 3), 8);
  });

  it('leaves the higher tier empty when the deal never reaches the hurdle', () => {
    // $1,400 out at t=3: pref 259.712 + capital 1,000 leaves 140.288, less than
    // the 326.45375 tier 1 needs to clear the 15% hurdle. Tier 2 gets nothing.
    const r = runWaterfall([-1000, 0, 0, 1400], TIERED);
    const last = r.periods[3];

    expect(last.residualByTier[0]).toBeCloseTo(140.288, 9);
    expect(last.residualByTier[1]).toBe(0);
    expect(last.gpPromote).toBeCloseTo(28.0576, 9);
    expect(last.lpDistribution).toBeCloseTo(1371.9424, 9);
    expect(r.tiers[0].hurdleMet).toBe(false);
    expect(r.returns.lpIRR).toBeLessThan(0.15);
  });

  it('clears the hurdle at precisely the IRR it names', () => {
    // The distribution that lands the LP exactly on 15% is
    //   259.712 (pref) + 1,000 (capital) + 261.163/0.80 (tier 1) = 1,586.16575.
    // The accreting-balance implementation and an actual IRR solve must agree
    // here or the hurdle means something other than what the term sheet says.
    const exact = runWaterfall([-1000, 0, 0, 1586.16575], TIERED);

    expect(exact.periods[3].lpDistribution).toBeCloseTo(1000 * Math.pow(1.15, 3), 6);
    expect(exact.periods[3].residualByTier[1]).toBeCloseTo(0, 6);
    expect(exact.tiers[0].hurdleMet).toBe(true);
    expect(annualize(irr(exact.lpFlows), 1)).toBeCloseTo(0.15, 8);

    // A dollar less and the hurdle is not met.
    const short = runWaterfall([-1000, 0, 0, 1585.16575], TIERED);
    expect(short.tiers[0].hurdleMet).toBe(false);
    expect(short.returns.lpIRR).toBeLessThan(0.15);
  });

  it('converts an IRR hurdle to the period rate that reproduces that IRR', () => {
    // The annual harness cannot see this: at periodsPerYear 1 every conversion
    // is the identity, so deleting the conversion entirely leaves it green. At
    // monthly granularity a 15% hurdle enforced as 15% per MONTH is 435% a year.
    const MONTHLY = {
      periodsPerYear: 12,
      prefRate: 0.08,
      catchUp: { enabled: false },
      tiers: [{ irrHurdle: 0.15, gpShare: 0.20 }, { irrHurdle: null, gpShare: 0.40 }],
    };
    const zeros = Array(35).fill(0);
    // Bisect for the distribution at which the tier-1 balance is exhausted.
    let lo = 1000;
    let hi = 3000;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (runWaterfall([-1000, ...zeros, mid], MONTHLY).tiers[0].hurdleMet) hi = mid; else lo = mid;
    }
    const atHurdle = runWaterfall([-1000, ...zeros, hi], MONTHLY);
    expect(atHurdle.tiers[0].hurdleMet).toBe(true);
    expect(annualize(irr(atHurdle.lpFlows), 12)).toBeCloseTo(0.15, 8);
    // 1,000 compounded at 15% for three years, which is what the hurdle says.
    expect(atHurdle.totals.lpDistributions).toBeCloseTo(1000 * Math.pow(1.15, 3), 4);
  });

  it('does not let the pref quoting convention re-price an IRR hurdle', () => {
    // prefRateBasis says how the PREF is quoted. An IRR is defined by
    // compounding, and returns.lpIRR annualizes by compounding, so keying the
    // hurdle off that field enforced a 15% hurdle at 16.075% and reported both
    // numbers in the same object.
    const base = {
      periodsPerYear: 12,
      prefRate: 0,                       // isolate the hurdle from the pref
      catchUp: { enabled: false },
      tiers: [{ irrHurdle: 0.15, gpShare: 0.20 }, { irrHurdle: null, gpShare: 0.40 }],
    };
    const zeros = Array(35).fill(0);
    const solve = (prefRateBasis) => {
      let lo = 1000;
      let hi = 3000;
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        const cfg = { ...base, prefRateBasis };
        if (runWaterfall([-1000, ...zeros, mid], cfg).tiers[0].hurdleMet) hi = mid; else lo = mid;
      }
      return hi;
    };
    expect(solve('nominal')).toBeCloseTo(solve('effective'), 6);
    const nominal = runWaterfall([-1000, ...zeros, 3000], { ...base, prefRateBasis: 'nominal' });
    const effective = runWaterfall([-1000, ...zeros, 3000], { ...base, prefRateBasis: 'effective' });
    expect(nominal.totals.gpPromote).toBeCloseTo(effective.totals.gpPromote, 9);
  });

  it('keeps a cleared hurdle cleared across later periods', () => {
    // Interim distributions carry the LP past 15% at t=1; the t=3 distribution
    // must then promote at the tier 2 rate, not restart at tier 1.
    const r = runWaterfall([-1000, 2000, 0, 500], TIERED);
    expect(r.tiers[0].hurdleMet).toBe(true);
    expect(r.periods[3].residualByTier[0]).toBe(0);
    expect(r.periods[3].residualByTier[1]).toBeCloseTo(500, 9);
    expect(r.periods[3].gpPromote).toBeCloseTo(200, 9);
  });
});

describe('loss cases', () => {
  it('pays the GP no promote when capital is not returned', () => {
    // $1,000 in, $400 back at t=3. Pref accrues to 259.712 and is paid in full;
    // the remaining 140.288 returns capital, leaving $859.712 outstanding.
    const r = runWaterfall([-1000, 0, 0, 400], ANNUAL);
    const last = r.periods[3];

    expect(last.prefPaid).toBeCloseTo(259.712, 9);
    expect(last.capitalReturned).toBeCloseTo(140.288, 9);
    expect(last.gpPromote).toBe(0);
    expect(r.totals.gpPromote).toBe(0);
    expect(r.returns.capitalShortfall).toBeCloseTo(859.712, 9);
    expect(r.returns.lpEquityMultiple).toBeCloseTo(0.4, 12);
    // 0.4^(1/3) - 1 = -0.26319...
    expect(r.returns.lpIRR).toBeCloseTo(-0.2631937, 6);
  });

  it('returns finite numbers and a null IRR on a total loss', () => {
    const r = runWaterfall([-1000, 0, 0, 0], ANNUAL);

    expect(r.returns.lpIRR).toBeNull();          // no positive flow: no root exists
    expect(r.returns.lpEquityMultiple).toBe(0);  // a known zero, not an unknown
    expect(r.returns.lpProfit).toBeCloseTo(-1000, 12);
    expect(r.totals.gpPromote).toBe(0);
    expect(Number.isFinite(r.returns.capitalShortfall)).toBe(true);
    expect(Number.isFinite(r.returns.prefShortfall)).toBe(true);
  });

  it('reports null rather than zero for a GP with promote but no capital at risk', () => {
    // The GP's flow series is all non-negative, so its IRR has no root. Zero
    // would read as "the sponsor broke even", which is the opposite of true.
    const r = runWaterfall([-1000, 0, 0, 0, 2000], ANNUAL);

    expect(r.totals.gpContributions).toBe(0);
    expect(r.totals.gpPromote).toBeGreaterThan(0);
    expect(r.returns.gpIRR).toBeNull();
    expect(r.returns.gpEquityMultiple).toBeNull();
  });

  it('handles an empty flow series without inventing numbers', () => {
    const r = runWaterfall([], ANNUAL);
    expect(r.periods).toEqual([]);
    expect(r.returns.lpIRR).toBeNull();
    expect(r.returns.lpEquityMultiple).toBeNull();
    expect(r.totals.distributions).toBe(0);
  });

  it('reports an unmet hurdle as unknown, not as met, when no capital was called', () => {
    // The hurdle balance starts at zero, so "nothing ever happened" and "the
    // sponsor achieved its 15% IRR" were the same reading. Rendering a promote
    // hurdle as achieved on a deal with no cash flows is the one shape of
    // unknown-as-a-value this module promises never to produce.
    const hurdled = {
      ...ANNUAL,
      tiers: [{ irrHurdle: 0.15, gpShare: 0.20 }, { irrHurdle: null, gpShare: 0.40 }],
    };
    for (const flows of [[], [0, 0, 0]]) {
      const r = runWaterfall(flows, hurdled);
      expect(r.returns.lpIRR).toBeNull();
      expect(r.tiers[0].hurdleMet).toBeNull();
    }
    // And a real deal still answers the question.
    expect(runWaterfall([-1000, 0, 0, 3000], hurdled).tiers[0].hurdleMet).toBe(true);
  });

  it('claws back promote the investors turn out not to have earned it on', () => {
    // Tier order makes promote unreachable while pref or capital is
    // outstanding, but only within a period. Distribute, promote, then call
    // fresh capital and the GP is promoted on money handed back and re-called:
    // 6,000 in, 6,000 out, zero profit, and a $200 promote against an LP loss.
    const flows = [-1000, 2000, -5000, 4000];
    const r = runWaterfall(flows, {
      periodsPerYear: 1,
      prefRate: 0.08,
      catchUp: { enabled: true, gpShare: 1.0 },
      tiers: [{ irrHurdle: null, gpShare: 0.20 }],
    });
    expect(r.totals.contributions).toBe(6000);
    expect(r.totals.distributions).toBe(6000);
    expect(r.totals.gpPromote).toBeGreaterThan(0);
    expect(r.totals.gpClawback).toBeCloseTo(r.totals.gpPromote, 9);
    expect(r.totals.gpPromoteNet).toBeCloseTo(0, 9);
    expect(r.returns.lpProfit).toBeCloseTo(0, 9);
    // The clawback is money already in the deal changing hands, so the split
    // still reconciles to the distributions.
    expect(r.totals.lpDistributions + r.totals.gpDistributions)
      .toBeCloseTo(r.totals.distributions, 9);
  });

  it('claws back no more promote than the GP received', () => {
    // A deal that loses money without ever paying promote has nothing to claw.
    const r = runWaterfall([-1000, 100, 100], ANNUAL);
    expect(r.totals.gpPromote).toBe(0);
    expect(r.totals.gpClawback).toBe(0);
    expect(r.returns.capitalShortfall).toBeGreaterThan(0);
  });
});

describe('GP co-investment', () => {
  it('treats sponsor capital pari passu and pays promote on top', () => {
    // Same deal as the 100% catch-up case, with the GP funding 20% of equity.
    // Investor-class outcome is unchanged: 166.40 pref + 1,000 capital + 633.60
    // residual = 1,800, split 80/20 by capital -> LP 1,440, GP co-invest 360.
    // GP total = 360 + 200 promote = 560 on $200 of capital.
    const r = runWaterfall([-1000, 0, 2000], {
      ...ANNUAL,
      gpCoInvestShare: 0.20,
      catchUp: { enabled: true, gpShare: 1.0 },
    });

    expect(r.totals.lpContributions).toBeCloseTo(800, 9);
    expect(r.totals.gpContributions).toBeCloseTo(200, 9);
    expect(r.totals.lpDistributions).toBeCloseTo(1440, 9);
    expect(r.totals.gpDistributions).toBeCloseTo(560, 9);
    expect(r.returns.lpEquityMultiple).toBeCloseTo(1.8, 12);
    expect(r.returns.gpEquityMultiple).toBeCloseTo(2.8, 12);
    expect(r.returns.lpIRR).toBeCloseTo(Math.sqrt(1.8) - 1, 8);   // 0.3416408
    expect(r.returns.gpIRR).toBeCloseTo(Math.sqrt(2.8) - 1, 8);   // 0.6733201
  });

  it('leaves the LP per-dollar outcome identical to a no-co-invest deal', () => {
    // Pari passu means the LP's multiple cannot depend on how much of the same
    // class the sponsor happens to own.
    const withCo = runWaterfall([-1000, 0, 2000], { ...ANNUAL, gpCoInvestShare: 0.35 });
    const without = runWaterfall([-1000, 0, 2000], ANNUAL);

    expect(withCo.returns.lpEquityMultiple).toBeCloseTo(without.returns.lpEquityMultiple, 12);
    expect(withCo.returns.lpIRR).toBeCloseTo(without.returns.lpIRR, 12);
  });
});

describe('configuration', () => {
  it('rejects a catch-up that can never complete', () => {
    // A catch-up share at or below the promote share never lifts the GP's
    // ratio to the target, so the tier would absorb every future dollar.
    expect(() => runWaterfall([-1, 2], { catchUp: { enabled: true, gpShare: 0.20 } }))
      .toThrow(/catchUp\.gpShare/);
  });

  it('rejects out-of-order hurdles', () => {
    expect(() => runWaterfall([-1, 2], {
      tiers: [{ irrHurdle: 0.18, gpShare: 0.2 }, { irrHurdle: 0.12, gpShare: 0.3 }],
    })).toThrow(/strictly increase/);
  });

  it('rejects an open-ended tier that is not last', () => {
    expect(() => runWaterfall([-1, 2], {
      tiers: [{ irrHurdle: null, gpShare: 0.2 }, { irrHurdle: 0.2, gpShare: 0.3 }],
    })).toThrow(/final tier/);
  });

  it('rejects a tier stack whose last tier still carries a hurdle', () => {
    // Every dollar has to land in a tier. A stack one line short used to be
    // given an invented terminal split, which both fabricated a promote and
    // booked dollars split above the hurdle against the tier below it.
    expect(() => runWaterfall([-1000, 0, 0, 3000], {
      periodsPerYear: 1, tiers: [{ irrHurdle: 0.15, gpShare: 0.20 }],
    })).toThrow(/final tier must be open-ended/);
  });

  it('rejects a pref rate basis it does not recognise', () => {
    // Unvalidated, every string but the literal 'nominal' selected 'effective',
    // so a capitalisation typo moved 30 bps a year with nothing on screen —
    // exactly the silent repair every other check here exists to prevent.
    expect(() => runWaterfall([-1, 2], { prefRateBasis: 'Effective' }))
      .toThrow(/prefRateBasis/);
    expect(() => runWaterfall([-1, 2], { prefRateBasis: 'annual' }))
      .toThrow(/prefRateBasis/);
  });

  it('catches up to the FIRST tier promote, not the last', () => {
    // The catch-up target defaults to tiers[0].gpShare. On the single-tier
    // default those are the same object, so only a multi-tier stack can tell
    // which one the fallback reads — and reading the last one over-promotes.
    const cfg = resolveWaterfall({
      periodsPerYear: 1,
      tiers: [{ irrHurdle: 0.14, gpShare: 0.20 }, { irrHurdle: null, gpShare: 0.30 }],
    });
    expect(cfg.catchUp.targetPromoteShare).toBe(0.20);
    expect(cfg.catchUp.targetPromoteShare).not.toBe(0.30);
  });

  it('rejects a 100% promote, which would make the tier unsolvable', () => {
    expect(() => runWaterfall([-1, 2], { tiers: [{ irrHurdle: 0.1, gpShare: 1 }] }))
      .toThrow(/gpShare/);
  });

  it('rejects non-finite cash flows rather than propagating NaN', () => {
    expect(() => runWaterfall([-1000, NaN, 2000], ANNUAL)).toThrow(TypeError);
  });

  it('is not hardcoded to 80/20', () => {
    // A 70/30 promote over a 12% pref, three tiers deep.
    const cfg = resolveWaterfall({
      periodsPerYear: 1,
      prefRate: 0.12,
      catchUp: { enabled: false },
      tiers: [
        { irrHurdle: 0.15, gpShare: 0.30 },
        { irrHurdle: 0.22, gpShare: 0.40 },
        { irrHurdle: null, gpShare: 0.50 },
      ],
    });
    expect(cfg.tiers).toHaveLength(3);

    const r = runWaterfall([-1000, 0, 0, 4000], cfg);
    // pref = 1,000 x (1.12^3 - 1) = 404.928
    // capital 1,000 -> LP has 1,404.928 against a 15% FV of 1,520.875,
    //   tier 1 needs 115.947 to the LP = 165.638571... gross (GP 30%)
    // 22% FV = 1,000 x 1.22^3 = 1,815.848; LP now at 1,520.875,
    //   tier 2 needs 294.973 to the LP = 491.621667 gross (GP 40%)
    // remainder = 4,000 - 404.928 - 1,000 - 165.638571 - 491.621667
    //           = 1,937.811762 -> GP 968.905881 / LP 968.905881
    const last = r.periods[3];
    expect(last.prefPaid).toBeCloseTo(404.928, 8);
    expect(last.residualByTier[0]).toBeCloseTo(165.6385714286, 6);
    expect(last.residualByTier[1]).toBeCloseTo(491.6216666667, 6);
    expect(last.residualByTier[2]).toBeCloseTo(1937.8117619048, 6);
    expect(last.lpDistribution).toBeCloseTo(
      404.928 + 1000 + 115.9470 + 294.9730 + 968.9058809524, 5
    );
  });

  it('supports return of capital ahead of the pref', () => {
    // Capital first: the $1,000 comes back before any of the 259.712 of pref,
    // so a $1,100 distribution leaves 159.712 of pref unpaid instead of
    // 159.712 of capital outstanding. Same LP dollars, different accrual base
    // going forward, which is exactly why the order is a config flag.
    const r = runWaterfall([-1000, 0, 0, 1100], { ...ANNUAL, returnOfCapitalFirst: true });
    const last = r.periods[3];

    expect(last.capitalReturned).toBeCloseTo(1000, 9);
    expect(last.prefPaid).toBeCloseTo(100, 9);
    expect(r.totals.unpaidPref).toBeCloseTo(159.712, 9);
    expect(r.totals.unreturnedCapital).toBeCloseTo(0, 9);
  });

  it('exposes defaults that describe a conventional 8% pref / 80-20 deal', () => {
    expect(DEFAULT_WATERFALL.prefRate).toBe(0.08);
    expect(DEFAULT_WATERFALL.tiers[0].gpShare).toBe(0.20);
    expect(resolveWaterfall({}).catchUp.targetPromoteShare).toBe(0.20);
  });
});

describe('conservation laws', () => {
  const cases = [
    { name: 'construction draws then a sale', flows: [-400, -400, -200, 100, 100, 3000] },
    { name: 'interim distributions', flows: [-1000, 60, 60, 60, 60, 1600] },
    { name: 'a capital call after distributions', flows: [-800, 200, -300, 150, 1400] },
    { name: 'a loss', flows: [-1000, 20, 20, 300] },
    { name: 'no distributions at all', flows: [-500, -500, 0, 0] },
  ];

  const cfg = {
    periodsPerYear: 1,
    prefRate: 0.08,
    gpCoInvestShare: 0.10,
    catchUp: { enabled: true, gpShare: 1.0 },
    tiers: [
      { irrHurdle: 0.14, gpShare: 0.20 },
      { irrHurdle: null, gpShare: 0.30 },
    ],
  };

  cases.forEach(({ name, flows }) => {
    it(`allocates every dollar and no more — ${name}`, () => {
      const r = runWaterfall(flows, cfg);

      r.periods.forEach((p, i) => {
        expect(p.lpDistribution + p.gpDistribution).toBeCloseTo(p.distribution, 8);
        expect(p.lpContribution + p.gpContribution).toBeCloseTo(p.contribution, 8);
        // The named tiers must account for the whole distribution — no
        // rounding crumbs left in the sponsor's pocket.
        expect(p.prefPaid + p.capitalReturned + p.catchUpPaid + p.catchUpToInvestors + p.residualPaid)
          .toBeCloseTo(p.distribution, 8);
        expect(p.lpFlow + p.gpFlow).toBeCloseTo(flows[i], 8);
        // Nothing may ever be paid out negative.
        expect(p.prefPaid).toBeGreaterThanOrEqual(0);
        expect(p.capitalReturned).toBeGreaterThanOrEqual(0);
        expect(p.gpPromote).toBeGreaterThanOrEqual(0);
      });

      expect(total(r, 'lpDistribution') + total(r, 'gpDistribution'))
        .toBeCloseTo(r.totals.distributions, 6);
    });

    it(`never promotes while pref or capital is outstanding — ${name}`, () => {
      const r = runWaterfall(flows, cfg);
      r.periods.forEach((p) => {
        if (p.unpaidPref > 1e-9 || p.unreturnedCapital > 1e-9) {
          expect(p.gpPromote).toBeCloseTo(0, 9);
        }
      });
    });
  });
});

describe('against runModel', () => {
  const deal = SAMPLE_DEALS[0];
  const model = runModel(deal);

  it('reconciles period by period with the model equity flows', () => {
    const w = waterfallFromModel(model);
    expect(w.periods).toHaveLength(model.months.length);

    model.months.forEach((m, i) => {
      expect(w.periods[i].lpFlow + w.periods[i].gpFlow).toBeCloseTo(m.equityFlow, 6);
    });
  });

  it('inherits the model own GP co-invest share instead of assuming one', () => {
    const w = waterfallFromModel(model);
    const share = model.financing.gpCoInvest / model.financing.equityCommitment;
    expect(w.config.gpCoInvestShare).toBeCloseTo(share, 12);
    expect(w.totals.gpContributions / w.totals.contributions).toBeCloseTo(share, 9);
  });

  it('leaves the LP below the whole-equity IRR by exactly the promote drag', () => {
    // The LP's flows are the model's equity flows scaled by the LP's capital
    // share, less the promote. Scaling cannot change an IRR, so any gap is the
    // promote — and it can only ever be a drag.
    const w = waterfallFromModel(model);
    expect(w.totals.gpPromote).toBeGreaterThan(0);
    expect(w.returns.lpIRR).toBeLessThan(model.returns.leveredIRR);

    const noPromote = waterfallFromModel(model, {
      catchUp: { enabled: false },
      tiers: [{ irrHurdle: null, gpShare: 0 }],
    });
    expect(noPromote.totals.gpPromote).toBeCloseTo(0, 6);
    expect(noPromote.returns.lpIRR).toBeCloseTo(model.returns.leveredIRR, 8);
  });

  it('annualizes a monthly waterfall consistently with finance.irr', () => {
    const w = waterfallFromModel(model);
    expect(w.returns.lpIRR).toBeCloseTo(annualize(irr(w.lpFlows), 12), 12);
  });

  it('pays no promote on a deal that loses the LP money', () => {
    // Same asset, exited at a punitive cap rate with the revenue halved.
    const bad = runModel({ ...deal, grossRevenue: deal.grossRevenue * 0.5, exitCapRate: 12 });
    const w = waterfallFromModel(bad);

    expect(w.returns.lpEquityMultiple).toBeLessThan(1);
    expect(w.totals.gpPromote).toBeCloseTo(0, 6);
    expect(w.returns.capitalShortfall).toBeGreaterThan(0);
    expect(Number.isFinite(w.returns.lpProfit)).toBe(true);
    expect(w.returns.lpProfit).toBeLessThan(0);
  });

  it('runs every sample deal without producing a non-finite figure', () => {
    SAMPLE_DEALS.forEach((d) => {
      const w = waterfallFromModel(runModel(d));
      const { lpIRR, gpIRR, lpEquityMultiple, gpEquityMultiple } = w.returns;
      [lpIRR, gpIRR, lpEquityMultiple, gpEquityMultiple].forEach((v) => {
        expect(v === null || Number.isFinite(v)).toBe(true);
      });
      expect(total(w, 'lpDistribution') + total(w, 'gpDistribution'))
        .toBeCloseTo(w.totals.distributions, 4);
      expect(w.totals.gpPromote).toBeGreaterThanOrEqual(0);
    });
  });

  it('rejects anything that is not a model result', () => {
    expect(() => waterfallFromModel(null)).toThrow(TypeError);
    expect(() => waterfallFromModel({})).toThrow(TypeError);
  });
});

describe('promoteState — the one predicate four surfaces run', () => {
  const structure = { prefRate: 0.08, tiers: [{ irrHurdle: 0.15, gpShare: 0.2 }, { irrHurdle: null, gpShare: 0.35 }] };
  const unrunnable = { tiers: [{ irrHurdle: 0.15, gpShare: 0.2 }] };   // no open-ended tier
  const model = runModel(SAMPLE_DEALS[0]);
  const noSchedule = runModel({ ...SAMPLE_DEALS[0], holdPeriod: 0 });

  it('separates no structure from one with nothing to split', () => {
    // These were the same state to the IC memo, whose only branch was whether
    // waterfallFromModel THREW. runWaterfall([]) does not throw — irr([])
    // returns null and the totals come back zero — so a deal with no equity
    // schedule got an "applied" disclosure over a $0 GP promote and a $0
    // preferred return stated as facts, while the CSV called the same deal
    // "Configured, no equity schedule to split" and the screen refused to
    // render a split at all.
    expect(promoteState(model, null).state).toBe('none');
    expect(promoteState(model, undefined).state).toBe('none');
    expect(noSchedule.months).toHaveLength(0);
    expect(promoteState(noSchedule, structure).state).toBe('no-flows');
    expect(promoteState(noSchedule, structure).wf).toBeNull();
  });

  it('names a refusal without applying it, and applies a runnable one', () => {
    const bad = promoteState(model, unrunnable);
    expect(bad.state).toBe('rejected');
    expect(bad.wf).toBeNull();
    expect(bad.reason).toMatch(/open-ended/i);
    // A reader's sentence, not a stack trace.
    expect(bad.reason).not.toMatch(/^waterfall:/);

    const good = promoteState(model, structure);
    expect(good.state).toBe('applied');
    expect(good.reason).toBeNull();
    expect(good.wf.returns.lpIRR).not.toBeNull();
  });

  it('strikes the promote on the capital stack the model funded, never on the structure', () => {
    // A gpCoInvestShare stored on the structure would split one equity
    // commitment two ways between the screen that stored it and the memo that
    // strips it — two documents reporting different promotes for one deal.
    const implied = model.financing.gpCoInvest / model.financing.equityCommitment;
    expect(implied).toBeGreaterThan(0);
    const forced = promoteState(model, { ...structure, gpCoInvestShare: 0 });
    expect(forced.wf.config.gpCoInvestShare).toBeCloseTo(implied, 12);
    expect(forced.wf.totals.gpPromoteNet)
      .toBeCloseTo(promoteState(model, structure).wf.totals.gpPromoteNet, 6);
  });

  it('treats a stored value that is not a structure as no structure', () => {
    for (const junk of ['{"prefRate":0.08}', 42, [], true]) {
      expect(promoteState(model, junk).state).toBe('none');
    }
  });
});
