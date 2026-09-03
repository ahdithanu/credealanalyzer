import {
  amortizingPayment,
  irr,
  annualize,
  npv,
  runModel,
  calculateMetrics,
  sizeDebt,
  DEFAULT_ASSUMPTIONS,
  DEFAULT_DEBT_SIZING,
} from '../finance';
import { suggestGrossRevenue, suggestConstructionCost, constructionTypes } from '../propertyTypes';
import { getPropertyTaxRate, resolveTaxRate, findMarket, distanceMiles } from '../markets';
import { SAMPLE_DEALS } from '../sampleDeals';
import { validate, breakEvenBreach } from '../validation';
import { runScenarios } from '../sensitivity';

/** A profitable ground-up car wash, used as the reference deal. */
const groundUpDeal = {
  name: 'Reference Ground-Up',
  propertyType: 'carwash',
  constructionType: 'groundUp',
  location: 'Houston, TX',
  purchasePrice: 500000,
  constructionCost: 1200000,
  buildingSize: 4800,
  grossRevenue: 580000,
  vacancyRate: 3,
  operatingExpenseRatio: 32,
  downPayment: 30,
  interestRate: 6.8,
  loanTerm: 25,
  exitCapRate: 7.2,
  holdPeriod: 5,
};

describe('amortizingPayment', () => {
  it('matches the standard level-payment formula', () => {
    // $1,000,000 @ 6.00% over 30 years = $5,995.51/mo
    expect(amortizingPayment(1_000_000, 0.06, 30)).toBeCloseTo(5995.51, 1);
  });

  it('handles a zero interest rate as straight-line principal', () => {
    expect(amortizingPayment(120_000, 0, 10)).toBeCloseTo(1000, 6);
  });

  it('returns zero for a non-positive principal or term', () => {
    expect(amortizingPayment(0, 0.06, 30)).toBe(0);
    expect(amortizingPayment(100_000, 0.06, 0)).toBe(0);
  });
});

describe('irr', () => {
  it('solves a single-period flow exactly', () => {
    expect(irr([-100, 110])).toBeCloseTo(0.10, 10);
  });

  it('solves a multi-period flow to a zero NPV', () => {
    const flows = [-1000, 500, 500, 500];
    const r = irr(flows);
    expect(r).not.toBeNull();
    expect(npv(r, flows)).toBeCloseTo(0, 6);
  });

  it('solves a negative-return flow', () => {
    const flows = [-1000, 300, 300, 300];
    const r = irr(flows);
    expect(r).toBeLessThan(0);
    expect(npv(r, flows)).toBeCloseTo(0, 6);
  });

  it('returns null when there is no sign change', () => {
    expect(irr([100, 200, 300])).toBeNull();
    expect(irr([-100, -200, -300])).toBeNull();
  });

  it('returns null rather than NaN for non-finite input', () => {
    expect(irr([-100, NaN, 200])).toBeNull();
    expect(irr([-100, Infinity])).toBeNull();
  });

  it('annualizes a monthly rate by compounding', () => {
    expect(annualize(0.01)).toBeCloseTo(Math.pow(1.01, 12) - 1, 12);
    expect(annualize(null)).toBeNull();
  });

  it('never returns a rate that does not zero the NPV', () => {
    // The named failure: on a long schedule, npv(-0.9999) divides a late flow
    // by ~1e-308 and, with flows of both signs, evaluates to Infinity minus
    // Infinity — NaN. NaN fails every comparison, so `fLo * fHi > 0` was false,
    // both the bracket-expansion loop and the no-root guard were skipped, and
    // bisection walked `lo` up to the untouched upper bound and returned it.
    // The shape below is the one that did it: a capital call, income, then a
    // terminal negative because the loan exceeds net sale value.
    const flows = [-1684050, ...Array(76).fill(21000), -273340];
    const r = irr(flows);
    if (r !== null) {
      const scale = flows.reduce((m, c) => Math.max(m, Math.abs(c)), 0);
      expect(Math.abs(npv(r, flows))).toBeLessThan(scale * 1e-5);
    }
  });

  it('reports no IRR rather than a bracket bound when the NPV never crosses zero', () => {
    // Same series. The NPV is negative at every rate, so no IRR exists and the
    // documented contract is null. It returned a monthly 1.0 — annualising to
    // +409,500% — beside a multiple below 1.0x.
    const flows = [-1684050, ...Array(76).fill(21000), -273340];
    expect(npv(0, flows)).toBeLessThan(0);
    expect(npv(5, flows)).toBeLessThan(0);
    expect(irr(flows)).toBeNull();
  });

  it('reports no levered IRR on a deal whose sale cannot repay the loan', () => {
    // The defect reached the first tile on the Deal Model screen, and the memo,
    // the CSV and the tornado behind it, on 52 of 396 sample parameter
    // combinations. No sampled deal may report an IRR above +300%.
    const outrageous = [];
    for (const deal of SAMPLE_DEALS) {
      for (const exitCapRate of [4, 8, 12, 16, 20]) {
        for (const holdPeriod of [3, 5, 7, 10]) {
          const m = runModel({ ...deal, exitCapRate, holdPeriod });
          if (m.incomplete || m.returns.leveredIRR === null) continue;
          if (m.returns.leveredIRR > 3) outrageous.push([deal.name, exitCapRate, holdPeriod, m.returns.leveredIRR]);
        }
      }
    }
    expect(outrageous).toEqual([]);
  });
});

describe('runModel — structure', () => {
  const r = runModel(groundUpDeal);

  it('produces a month for every construction and operating period', () => {
    expect(r.timeline.constructionMonths).toBe(18);
    expect(r.timeline.operatingMonths).toBe(60);
    expect(r.months).toHaveLength(78);
  });

  it('capitalizes construction interest into basis', () => {
    expect(r.budget.capitalizedInterest).toBeGreaterThan(0);
    expect(r.budget.totalProjectCost).toBeGreaterThan(r.budget.baseProjectCost);
    expect(r.budget.totalProjectCost).toBeCloseTo(
      r.budget.baseProjectCost + r.budget.capitalizedInterest, 6,
    );
  });

  it('breaks the budget into discrete sources & uses lines', () => {
    const hard = 1_200_000;
    const soft = hard * 0.14;
    const contingency = (hard + soft) * 0.15;
    expect(r.budget.hardCost).toBeCloseTo(hard, 6);
    expect(r.budget.softCost).toBeCloseTo(soft, 6);
    expect(r.budget.contingency).toBeCloseTo(contingency, 6);
    expect(r.budget.baseProjectCost).toBeCloseTo(500_000 + hard + soft + contingency, 6);
  });

  it('emits sources & uses lines that reconcile to total development cost', () => {
    const sum = r.budget.lines.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBeCloseTo(r.budget.totalProjectCost, 4);
    expect(r.budget.lines.map((l) => l.key)).toContain('interestReserve');
  });

  it('splits the capital stack into senior debt, LP and GP equity', () => {
    const { equityCommitment, lpEquity, gpCoInvest } = r.financing;
    expect(lpEquity + gpCoInvest).toBeCloseTo(equityCommitment, 6);
    expect(gpCoInvest).toBeCloseTo(equityCommitment * 0.2, 6);
  });

  it('draws equity before debt during construction', () => {
    const firstMonth = r.months[0];
    expect(firstMonth.equityDraw).toBeGreaterThan(0);
    expect(firstMonth.loanBalance).toBe(0);
  });

  it('never emits a non-finite figure in the schedule', () => {
    for (const m of r.months) {
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === 'number') {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  it('is deterministic', () => {
    expect(runModel(groundUpDeal)).toEqual(runModel(groundUpDeal));
  });
});

describe('runModel — exit and debt (the corrected math)', () => {
  const r = runModel(groundUpDeal);

  it('nets the OUTSTANDING loan balance, not the original loan amount', () => {
    // The original implementation used `exitValue - totalProjectCost`, which
    // silently discarded every dollar of principal amortised over the hold.
    expect(r.exit.loanPayoff).toBeLessThan(r.financing.permanentLoanBalance);
    expect(r.exit.netSaleProceeds).toBeCloseTo(
      r.exit.grossSalePrice - r.exit.costOfSale - r.exit.loanPayoff, 6,
    );
  });

  it('charges a cost of sale at disposition', () => {
    expect(r.exit.costOfSale).toBeCloseTo(
      r.exit.grossSalePrice * DEFAULT_ASSUMPTIONS.costOfSalePct, 6,
    );
  });

  it('prices the exit off forward NOI, not year-one NOI', () => {
    // With positive rent growth, forward NOI must exceed the stabilised year.
    expect(r.exit.forwardNoi).toBeGreaterThan(r.operating.stabilizedNOI);
    expect(r.exit.grossSalePrice).toBeCloseTo(r.exit.forwardNoi / (groundUpDeal.exitCapRate / 100), 6);
  });

  it('amortises the loan balance to zero-or-above across the hold', () => {
    const balances = r.months.slice(r.timeline.constructionMonths).map((m) => m.loanBalance);
    expect(Math.min(...balances)).toBeGreaterThanOrEqual(0);
    expect(balances[balances.length - 1]).toBeLessThan(balances[0]);
  });
});

describe('runModel — returns', () => {
  const r = runModel(groundUpDeal);

  it('reports a plausible levered IRR for a profitable deal', () => {
    expect(r.returns.leveredIRR).not.toBeNull();
    expect(r.returns.leveredIRR).toBeGreaterThan(0);
    expect(r.returns.leveredIRR).toBeLessThan(2); // sanity bound, not a target
  });

  it('levers returns above the unlevered IRR when the deal covers its debt', () => {
    expect(r.returns.leveredIRR).toBeGreaterThan(r.returns.unleveredIRR);
  });

  it('reconciles the equity multiple with distributions over contributions', () => {
    expect(r.returns.equityMultiple).toBeCloseTo(
      r.returns.totalDistributions / r.returns.totalEquityInvested, 9,
    );
    expect(r.returns.equityMultiple).toBeGreaterThan(1);
  });

  it('reports peak equity at least as large as the equity commitment', () => {
    expect(r.returns.peakEquity).toBeGreaterThanOrEqual(r.financing.equityCommitment - 1);
  });

  it('ties profit to the sum of equity cash flows', () => {
    const sum = r.months.reduce((s, m) => s + m.equityFlow, 0);
    expect(r.returns.profit).toBeCloseTo(sum, 6);
  });
});

describe('runModel — operating metrics', () => {
  const r = runModel(groundUpDeal);

  it('reports yield on cost against total project cost', () => {
    expect(r.operating.yieldOnCost).toBeCloseTo(
      r.operating.stabilizedNOI / r.budget.totalProjectCost, 9,
    );
  });

  it('reports the development spread in basis points against the exit cap', () => {
    expect(r.operating.developmentSpreadBps).toBeCloseTo(
      (r.operating.yieldOnCost - groundUpDeal.exitCapRate / 100) * 10000, 6,
    );
  });

  it('reports a minimum DSCR no greater than the stabilised DSCR', () => {
    expect(r.operating.minDSCR).toBeLessThanOrEqual(r.operating.stabilizedDSCR + 1e-9);
  });

  it('ramps occupancy through lease-up and holds it at stabilisation', () => {
    const ops = r.months.slice(r.timeline.constructionMonths);
    expect(ops[0].occ).toBeLessThan(ops[11].occ);
    const stabilized = ops.filter((m) => m.phase === 'stabilized');
    expect(stabilized[0].occ).toBeCloseTo(1 - groundUpDeal.vacancyRate / 100, 9);
  });

  it('does not let a vacant building look cheap to operate', () => {
    // Fixed opex must persist through lease-up: month-one opex should exceed
    // the naive "opex ratio x actual EGI" figure.
    const first = r.months[r.timeline.constructionMonths];
    expect(first.opex).toBeGreaterThan(first.egi * (groundUpDeal.operatingExpenseRatio / 100));
  });
});

describe('runModel — degenerate and losing deals', () => {
  it('never produces NaN for a deal that loses more than its equity', () => {
    const disaster = { ...groundUpDeal, grossRevenue: 40_000, exitCapRate: 12, downPayment: 10 };
    const m = calculateMetrics(disaster);
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number') expect(Number.isNaN(v)).toBe(false);
    }
    // The original CAGR formula raised a negative base to a fractional power
    // here and rendered "NaN%". An unrecoverable IRR must be null instead.
    expect(m.annualizedReturn === null || Number.isFinite(m.annualizedReturn)).toBe(true);
  });

  it('returns an incomplete result rather than throwing on an empty deal', () => {
    const r = runModel({});
    expect(r.incomplete).toBe(true);
    expect(r.returns.leveredIRR).toBeNull();
  });

  it('handles a zero hold period without dividing by zero', () => {
    const r = runModel({ ...groundUpDeal, holdPeriod: 0 });
    expect(r.incomplete).toBe(true);
  });

  it('handles an all-cash deal with no debt', () => {
    const r = runModel({ ...groundUpDeal, downPayment: 100 });
    expect(r.financing.loanCommitment).toBeCloseTo(0, 6);
    expect(r.financing.permanentLoanBalance).toBeCloseTo(0, 6);
    expect(r.operating.stabilizedDSCR).toBeNull();
    expect(r.returns.leveredIRR).toBeCloseTo(r.returns.unleveredIRR, 3);
  });
});

describe('runModel — acquisition with in-place income', () => {
  const renovation = {
    ...groundUpDeal,
    constructionType: 'acquisition',
    assumptions: { inPlaceRevenue: 400_000 },
  };

  it('services construction-period interest from in-place income', () => {
    const withIncome = runModel(renovation);
    const without = runModel({ ...groundUpDeal, constructionType: 'acquisition' });
    // Income during renovation reduces the interest that must be capitalised.
    expect(withIncome.budget.capitalizedInterest).toBeLessThan(without.budget.capitalizedInterest);
  });

  it('charges property tax and capital reserves through the renovation months', () => {
    // The named failure: crediting in-place income net of OPERATING EXPENSE
    // ALONE — no property tax, no capital reserve — while the operating period
    // subtracts both, and while operatingExpenseRatio is documented throughout
    // this codebase as EXCLUDING property tax. The renovation months then
    // service construction interest out of income the asset never earns, so
    // less interest is capitalised, basis is understated and every return
    // struck against basis is flattered.
    const r = runModel(renovation);
    const month = r.months[0];
    expect(month.phase).toBe('construction');

    const tax = 500_000 * (getPropertyTaxRate('Houston, TX') / 100);
    const reserve = r.assumptions.capexReserveAnnual;
    const stabilizedOcc = 1 - 0.03;
    const inPlaceOcc = 400_000 / 580_000;
    const opex = 580_000 * 0.32 * stabilizedOcc * (0.70 + 0.30 * (inPlaceOcc / stabilizedOcc));
    expect(tax).toBeGreaterThan(0);
    expect(reserve).toBeGreaterThan(0);

    // The month is priced from the inputs, independently of the engine. The
    // previous form of this test asserted `noi + a > noi` and
    // `(noi + a) - noi === a`, which are true of any noi at all: reverting the
    // whole policy change, or doubling the tax basis, left it green.
    expect(month.noi).toBeCloseTo((400_000 - opex - tax - reserve) / 12, 6);
    // ...and each charge is individually present, not merely netted somewhere.
    expect(month.tax).toBeCloseTo(tax / 12, 6);
    expect(month.reserve).toBeCloseTo(reserve / 12, 6);
    expect(month.opex).toBeCloseTo(opex / 12, 6);
  });

  it('prices a renovation month exactly as the operating schedule prices the same asset', () => {
    // The claim the policy change makes is that the renovation months are on
    // the SAME definition of NOI the operating schedule uses. Comparing the
    // schedule to `goingInNOI` cannot test that claim — goingInNOI is assigned
    // FROM the schedule's own figure, so the comparison is x === x. This
    // compares it to the other schedule.
    //
    // The two are held to identical conditions: no growth, no lease-up, an
    // all-cash deal (so no interest is capitalised and the operating period's
    // tax basis is the purchase price the renovation period's tax is struck
    // on), no renovation spend, and in-place rent set to exactly the stabilised
    // occupancy. Every line must then agree to the cent.
    //
    // It did not. The renovation months grossed the FIXED opex component to
    // 100% occupancy while the operating months budget it at stabilised
    // occupancy, so the same asset at the same occupancy was 3.7% apart on
    // opex — and 26 bps apart in the going-in cap rate the CSV exports.
    const vacancyRate = 6;
    const stabilizedOcc = 1 - vacancyRate / 100;
    const grossRevenue = 1_000_000;
    const flat = {
      propertyType: 'office', constructionType: 'acquisition', location: 'Plano, TX',
      purchasePrice: 12_000_000, constructionCost: 0, buildingSize: 50_000,
      grossRevenue, vacancyRate, operatingExpenseRatio: 30,
      downPayment: 100, interestRate: 6, loanTerm: 25, exitCapRate: 6.5, holdPeriod: 5,
      assumptions: {
        inPlaceRevenue: grossRevenue * stabilizedOcc,
        rentGrowth: 0, expenseGrowth: 0, assessmentGrowth: 0,
        leaseUpMonths: 0, initialOccupancy: stabilizedOcc,
      },
    };
    const r = runModel(flat);
    expect(r.budget.capitalizedInterest).toBe(0);
    const renovation = r.months[0];
    const operating = r.months[r.timeline.constructionMonths];
    expect(renovation.phase).toBe('construction');
    expect(operating.phase).toBe('stabilized');
    for (const key of ['gpr', 'occ', 'egi', 'recoveries', 'opex', 'tax', 'reserve', 'noi']) {
      expect(renovation[key]).toBeCloseTo(operating[key], 6);
    }
  });

  it('reports the same in-place NOI it charges, on every deal that has one', () => {
    // The exported row carries a going-in NOI beside IRR, profit and equity
    // multiple cells that are produced by the schedule. If the two disagree the
    // row is describing two different assets. They were 312 bps apart on Alamo
    // Ridge because only one of them netted tax, reserves and recoveries.
    //
    // The reconciliation must cover the deal it is hardest on. Dallas Office TI
    // is bought empty, so it has no going-in cap RATE — and while goingInNOI
    // was gated on the rate, this loop skipped the one deal in the portfolio
    // where the schedule and the reported figure could actually diverge.
    let checkedBoughtEmpty = 0;
    for (const deal of [renovation, ...SAMPLE_DEALS]) {
      const r = runModel(deal);
      const renovationMonths = r.months.filter((m) => m.phase === 'construction');
      if (!constructionTypes[deal.constructionType ?? 'groundUp'].hasInPlaceIncome) {
        expect(r.operating.goingInNOI).toBeNull();
        continue;
      }
      expect(r.operating.goingInNOI).not.toBeNull();
      expect(renovationMonths.length).toBeGreaterThan(0);
      for (const m of renovationMonths) {
        expect(m.noi * 12).toBeCloseTo(r.operating.goingInNOI, 6);
      }
      if (r.operating.goingInCapRate === null) {
        checkedBoughtEmpty++;
      } else {
        expect(r.operating.goingInCapRate)
          .toBeCloseTo(r.operating.goingInNOI / r.operating.acquisitionBasis, 12);
      }
    }
    // The sample portfolio must keep exercising the no-cap-rate case.
    expect(checkedBoughtEmpty).toBeGreaterThan(0);
  });

  it('never reports the lender paying the borrower during renovation', () => {
    // `debtService` was `min(inPlaceNOI, interest)`, which is safe only while
    // in-place NOI cannot go negative. Charging tax and fixed opex against an
    // asset bought empty made it negative, so the schedule reported a negative
    // debt service — rendered as a positive inflow on the Cash Flow screen, and
    // netted against the real debt service in the annual roll-up the IC memo
    // prints. A month that pays nothing pays zero, and capitalises the rest.
    for (const deal of [{ ...groundUpDeal, constructionType: 'acquisition' }, ...SAMPLE_DEALS]) {
      const r = runModel(deal);
      for (const m of r.months) {
        expect(m.debtService).toBeGreaterThanOrEqual(0);
        // Renovation debt service is capped at the interest accrued: nothing
        // amortises before completion, so a month cannot pay more than it owes.
        // (Operating months legitimately exceed interest — the level payment
        // carries principal.)
        if (m.phase === 'construction') {
          expect(m.debtService).toBeLessThanOrEqual(m.interest + 1e-9);
        }
      }
      for (const y of r.annual) expect(y.debtService).toBeGreaterThanOrEqual(0);
    }
    const empty = runModel({ ...groundUpDeal, constructionType: 'acquisition' });
    expect(empty.months[0].noi).toBeLessThan(0);
    expect(empty.months[0].debtService).toBe(0);
  });

  it('carries every cash flow line through the renovation months, so the year foots', () => {
    // rollUpAnnual sums each component key. Renovation months carrying `noi`
    // and nothing else produced a year-one row whose NOI was net of tax and
    // opex that the Tax and OpEx columns beside it reported as $0 — the IC
    // memo's annual cash flow table, which prints exactly those columns.
    for (const deal of [{ ...groundUpDeal, constructionType: 'acquisition' }, ...SAMPLE_DEALS]) {
      const r = runModel(deal);
      for (const y of r.annual) {
        expect(y.egi + y.recoveries - y.opex - y.tax - y.reserve).toBeCloseTo(y.noi, 6);
        expect(y.noi - y.debtService).toBeCloseTo(y.cashFlow, 6);
      }
    }
  });

  it('carries the tax and fixed opex of an asset bought empty rather than reading zero', () => {
    // A renovation asset with nothing let still pays its tax bill and its fixed
    // operating cost. Reporting zero NOI for those months claims a building
    // that costs nothing to hold, and hands the interest reserve the same
    // flattery in the opposite direction.
    const empty = runModel({ ...groundUpDeal, constructionType: 'acquisition' });
    const month = empty.months[0];
    expect(month.phase).toBe('construction');
    expect(month.noi).toBeLessThan(0);
    // ...and it costs real money: the reserve is larger than it would be with
    // the renovation months credited at zero.
    const asIfFree = runModel({
      ...groundUpDeal, constructionType: 'acquisition',
      purchasePrice: 500_000, operatingExpenseRatio: 0, propertyTaxRate: 0,
    });
    expect(empty.budget.capitalizedInterest).toBeGreaterThan(asIfFree.budget.capitalizedInterest);
    expect(empty.budget.totalProjectCost).toBeGreaterThan(asIfFree.budget.totalProjectCost);
  });

  it('bills renovation-period recoveries only on space that is actually let', () => {
    // Under NNN the tenant repays opex and tax pro rata to occupied space. A
    // half-let building credited at full occupancy collects reimbursements from
    // tenants who are not there, which is how a negative in-place NOI came to
    // read as a positive going-in yield.
    const nnn = {
      propertyType: 'retail', constructionType: 'acquisition', location: 'Tampa, FL',
      purchasePrice: 5_200_000, constructionCost: 1_100_000, buildingSize: 18_000,
      grossRevenue: 558_000, vacancyRate: 6, operatingExpenseRatio: 20,
      downPayment: 30, interestRate: 6.1, loanTerm: 25, exitCapRate: 7.0, holdPeriod: 5,
    };
    const quarterLet = runModel({ ...nnn, assumptions: { inPlaceRevenue: 140_000 } });
    const mostlyLet = runModel({ ...nnn, assumptions: { inPlaceRevenue: 480_000 } });
    const occQuarter = 140_000 / 558_000;
    const occMostly = 480_000 / 558_000;
    // Recoveries per dollar of in-place rent rise with occupancy, so the gap
    // between the two schedules is wider than the rent difference alone.
    expect(mostlyLet.months[0].noi - quarterLet.months[0].noi)
      .toBeGreaterThan((480_000 - 140_000) / 12);
    expect(occMostly).toBeGreaterThan(occQuarter);
  });

  it('leaves a ground-up schedule with no in-place income at all', () => {
    // A ground-up deal runs no operating statement during construction: there
    // is no building, no rent roll and no tenant to bill, and its land carry —
    // tax, insurance, the rest — is budgeted inside the 14% soft cost load
    // constructionTypes.groundUp applies (against 6-8% for acquisition and TI).
    // Charging tax here alone, with no offsetting soft-cost relief, would
    // double-count it. The renovation charge must not leak onto a construction
    // deal. See the note in the module header for what this convention costs.
    const r = runModel(groundUpDeal);
    for (const m of r.months.filter((x) => x.phase === 'construction')) {
      expect(m.noi).toBe(0);
    }
    expect(r.operating.goingInNOI).toBeNull();
  });
});

describe('propertyTypes helpers', () => {
  it('suggests revenue per SF for PSF-basis property types', () => {
    // Regression: the original helper multiplied by SF then divided the same
    // SF back out, suggesting "$28" as annual gross revenue for a 25,000 SF office.
    expect(suggestGrossRevenue({ propertyType: 'office', buildingSize: 25_000 })).toBe(28 * 25_000);
  });

  it('suggests revenue per unit for multifamily', () => {
    expect(suggestGrossRevenue({ propertyType: 'multifamily', units: 80 })).toBe(24_000 * 80);
  });

  it('suggests a flat site revenue for car wash', () => {
    expect(suggestGrossRevenue({ propertyType: 'carwash', buildingSize: 4800 })).toBe(580_000);
  });

  it('suggests construction cost per SF by construction type', () => {
    expect(suggestConstructionCost({ propertyType: 'office', constructionType: 'ti', buildingSize: 25_000 }))
      .toBe(85 * 25_000);
  });
});

describe('markets', () => {
  it('resolves known cities to their effective tax rate', () => {
    expect(getPropertyTaxRate('Houston, TX')).toBe(2.81);
    expect(getPropertyTaxRate('miami')).toBe(1.02);
  });

  it('prefers the longest city match so multi-word cities are not shadowed', () => {
    expect(findMarket('Fort Lauderdale, FL').key).toBe('fort-lauderdale-fl');
    expect(findMarket('West Palm Beach, FL').key).toBe('west-palm-beach-fl');
  });

  it('falls back to state, then to the default rate', () => {
    expect(resolveTaxRate('TX').basis).toBe('state');
    expect(resolveTaxRate('Boise, ID').basis).toBe('default');
    expect(getPropertyTaxRate('Boise, ID')).toBe(1.5);
  });

  it('marks every seed record with its data quality so the UI can warn', () => {
    expect(findMarket('Houston, TX').provenance.dataQuality).toBe('seed');
  });

  it('computes great-circle distance', () => {
    const d = distanceMiles(findMarket('Houston'), findMarket('Dallas'));
    expect(d).toBeGreaterThan(215);
    expect(d).toBeLessThan(235);
  });
});

describe('expense recovery (NNN leases)', () => {
  const industrial = {
    propertyType: 'industrial', constructionType: 'groundUp', location: 'Houston, TX',
    purchasePrice: 8_000_000, constructionCost: 61_000_000, buildingSize: 642_000,
    grossRevenue: 6_740_000, vacancyRate: 5, operatingExpenseRatio: 25,
    downPayment: 35, interestRate: 6.6, loanTerm: 25, exitCapRate: 6.9, holdPeriod: 7,
  };

  it('reimburses operating cost and tax under an NNN property type', () => {
    const r = runModel(industrial);
    const m = r.months[r.timeline.constructionMonths + 24];
    expect(m.recoveries).toBeGreaterThan(0);
    expect(m.recoveries).toBeCloseTo((m.opex + m.tax) * 0.95 * m.occ, 6);
  });

  it('recovers nothing for gross-lease property types', () => {
    const mf = runModel({ ...industrial, propertyType: 'multifamily', units: 300 });
    const m = mf.months[mf.timeline.constructionMonths + 24];
    expect(m.recoveries).toBe(0);
  });

  it('scales recoveries with occupancy during lease-up', () => {
    const r = runModel(industrial);
    const ops = r.months.slice(r.timeline.constructionMonths);
    const early = ops[0];
    const stable = ops.find((x) => x.phase === 'stabilized');
    expect(early.recoveries / (early.opex + early.tax))
      .toBeLessThan(stable.recoveries / (stable.opex + stable.tax));
  });

  it('makes a Texas NNN deal financeable where a gross model would not', () => {
    const withRecovery = runModel(industrial);
    const without = runModel({ ...industrial, expenseRecoveryRate: 0 });
    expect(withRecovery.operating.yieldOnCost).toBeGreaterThan(without.operating.yieldOnCost);
    expect(without.operating.yieldOnCost).toBeLessThan(0.05);
    expect(withRecovery.operating.yieldOnCost).toBeGreaterThan(0.06);
  });

  it('honours an explicit per-deal override of the type default', () => {
    const half = runModel({ ...industrial, expenseRecoveryRate: 0.5 });
    expect(half.assumptions.expenseRecoveryRate).toBe(0.5);
  });
});

describe('annual roll-up', () => {
  const r = runModel(groundUpDeal);

  it('carries every line the cash flow statement renders', () => {
    for (const key of ['gpr', 'egi', 'recoveries', 'opex', 'tax', 'reserve', 'noi', 'debtService', 'cashFlow']) {
      expect(r.annual[0]).toHaveProperty(key);
      expect(Number.isFinite(r.annual[0][key])).toBe(true);
    }
  });

  it('marks a stub final period rather than letting it read as a collapse', () => {
    // 18 construction + 60 operating months = 78 = six and a half years.
    const last = r.annual[r.annual.length - 1];
    expect(last.partial).toBe(true);
    expect(last.months).toBe(6);
    expect(r.annual.slice(0, -1).every((y) => y.partial === false)).toBe(true);
  });

  it('reconciles annual NOI to the sum of its months', () => {
    const monthly = r.months.slice(12, 24).reduce((s, m) => s + m.noi, 0);
    expect(r.annual[1].noi).toBeCloseTo(monthly, 6);
  });
});

// ─── break-even occupancy ────────────────────────────────────────────────────

/** Sum a field across the twelve months of the stabilized year. */
function stabilizedWindow(r) {
  const start = r.operating.stabilizationMonth;
  const window = r.months.slice(start, start + 12);
  const sum = (k) => window.reduce((s, m) => s + (m[k] || 0), 0);
  return { window, sum };
}

describe('break-even occupancy', () => {
  it('is the occupancy at which revenue exactly covers cash outgoings', () => {
    const r = runModel(groundUpDeal);   // car wash: gross lease, no reimbursements
    const { sum } = stabilizedWindow(r);
    // The schedule budgets opex against effective income, so the same cost is
    // grossed back to 100% to sit on the same occupancy basis as the potential
    // revenue it is measured against.
    const opexAtFullOccupancy = sum('opex') / r.operating.stabilizedOccupancy;
    const outgoings = opexAtFullOccupancy + sum('tax') + sum('reserve') + sum('debtService');
    expect(r.operating.stabilizedOutgoings).toBeCloseTo(outgoings, 6);
    expect(r.operating.breakEvenOccupancy).toBeCloseTo(outgoings / sum('gpr'), 9);
  });

  it('does not move with the vacancy assumption', () => {
    // The failure this guards, and the reason cost is grossed to full
    // occupancy: the schedule's opex budget shrinks as vacancy rises, so
    // pricing it against revenue at 100% made break-even FALL as the
    // underwriting got worse. The same building, rents and debt then read
    // safer the emptier it was assumed to be, and the covenant flag went
    // silent on exactly the deals that needed it. What a vacancy assumption
    // is allowed to move is the cushion, not the break-even itself.
    const tight = runModel({ ...groundUpDeal, vacancyRate: 3 });
    const loose = runModel({ ...groundUpDeal, vacancyRate: 30 });
    expect(loose.operating.stabilizedDSCR).toBeLessThan(tight.operating.stabilizedDSCR);
    expect(loose.operating.breakEvenOccupancy)
      .toBeCloseTo(tight.operating.breakEvenOccupancy, 12);
    const cushion = (r) => r.operating.stabilizedOccupancy - r.operating.breakEvenOccupancy;
    expect(cushion(loose)).toBeLessThan(cushion(tight));
  });

  it('counts debt service, not just operating cost', () => {
    // The failure this guards: a break-even that omits debt service reports the
    // occupancy at which the asset breaks even UNLEVERED, which no lender asks
    // about and which understates the covenant risk on a geared deal.
    const levered = runModel(groundUpDeal);
    const allCash = runModel({ ...groundUpDeal, downPayment: 100 });
    const { sum } = stabilizedWindow(allCash);
    const opexAtFullOccupancy = sum('opex') / allCash.operating.stabilizedOccupancy;
    expect(allCash.operating.stabilizedDebtService).toBe(0);
    expect(allCash.operating.breakEvenOccupancy).toBeCloseTo(
      (opexAtFullOccupancy + sum('tax') + sum('reserve')) / sum('gpr'), 9,
    );
    expect(levered.operating.breakEvenOccupancy)
      .toBeGreaterThan(allCash.operating.breakEvenOccupancy);
  });

  it('counts property tax, which is not inside the operating expense ratio', () => {
    const houston = runModel(groundUpDeal);                              // 2.81%
    const boise = runModel({ ...groundUpDeal, location: 'Boise, ID' });  // 1.50%
    expect(houston.operating.breakEvenOccupancy)
      .toBeGreaterThan(boise.operating.breakEvenOccupancy);
  });

  it('counts capital reserves', () => {
    const withReserve = runModel(groundUpDeal);
    const { sum } = stabilizedWindow(withReserve);
    expect(sum('reserve')).toBeGreaterThan(0);
    const outgoingsWithout = sum('opex') + sum('tax') + sum('debtService');
    expect(withReserve.operating.breakEvenOccupancy)
      .toBeGreaterThan(outgoingsWithout / sum('gpr'));
  });

  it('rises with leverage and with the cost of debt', () => {
    const base = runModel(groundUpDeal).operating.breakEvenOccupancy;
    expect(runModel({ ...groundUpDeal, downPayment: 15 }).operating.breakEvenOccupancy)
      .toBeGreaterThan(base);
    expect(runModel({ ...groundUpDeal, interestRate: 9.5 }).operating.breakEvenOccupancy)
      .toBeGreaterThan(base);
  });

  it('treats expense reimbursements as revenue that arrives with occupancy', () => {
    // Under NNN the tenant repays operating cost and tax, so those dollars are
    // potential revenue. The two other placements both misreport this 642,000
    // SF asset, which covers 1.36x: charging the expenses to the landlord and
    // crediting only base rent puts break-even above full occupancy, and
    // netting the recoveries out of the outgoings instead credits them at 100%
    // whatever the occupancy, understating break-even by eleven points.
    const industrial = {
      propertyType: 'industrial', constructionType: 'groundUp', location: 'Houston, TX',
      purchasePrice: 8_000_000, constructionCost: 61_000_000, buildingSize: 642_000,
      grossRevenue: 7_223_000, vacancyRate: 5, operatingExpenseRatio: 25,
      downPayment: 35, interestRate: 6.6, loanTerm: 25, exitCapRate: 6.9, holdPeriod: 7,
    };
    const nnn = runModel(industrial);
    const gross = runModel({ ...industrial, expenseRecoveryRate: 0 });
    expect(nnn.operating.stabilizedDSCR).toBeGreaterThan(1.25);
    expect(nnn.operating.breakEvenOccupancy).toBeLessThan(1);
    // Omitting recoveries: above full occupancy on an asset covering 1.36x.
    expect(gross.operating.breakEvenOccupancy).toBeGreaterThan(1);
    expect(nnn.operating.breakEvenOccupancy).toBeLessThan(gross.operating.breakEvenOccupancy);
    // Netting them out of the numerator instead. Outgoings and potential rent
    // are identical between the two runs, so the recovery potential is the
    // difference in the denominators.
    const recoveryPotential =
      nnn.operating.grossPotentialRevenue - gross.operating.grossPotentialRevenue;
    const netted =
      (nnn.operating.stabilizedOutgoings - recoveryPotential) / gross.operating.grossPotentialRevenue;
    expect(recoveryPotential).toBeGreaterThan(0);
    expect(nnn.operating.breakEvenOccupancy).toBeGreaterThan(netted + 0.10);
  });

  it('leaves a cushion on every sample deal that covers its debt', () => {
    // Not a theorem: break-even is struck on a full-occupancy expense budget
    // while DSCR is struck on the underwritten one, so a thin deal carrying
    // heavy assumed vacancy can clear 1.0x and still show no cushion — which is
    // the disclosure, and is flagged. What must not happen is the shipped
    // portfolio reporting two contradictory answers about the same deal.
    for (const deal of SAMPLE_DEALS) {
      const r = runModel(deal);
      if (!(r.operating.stabilizedDSCR >= 1)) continue;
      expect(r.operating.breakEvenOccupancy).toBeLessThan(r.operating.stabilizedOccupancy);
    }
  });

  it('is null rather than zero when there is no revenue to break even against', () => {
    const r = runModel({ ...groundUpDeal, grossRevenue: 0 });
    expect(r.operating.grossPotentialRevenue).toBe(0);
    expect(r.operating.breakEvenOccupancy).toBeNull();
  });

  it('is null for a net-leased asset with no rent, where recoveries alone are not a denominator', () => {
    // Property tax is charged on basis whether or not anything is let, so
    // reimbursement potential keeps the denominator positive on a building with
    // nothing to lease. It reported a break-even above 300% rather than 'n/a'.
    const nnnNoRent = {
      propertyType: 'retail', constructionType: 'groundUp', location: 'Houston, TX',
      purchasePrice: 2_000_000, constructionCost: 6_000_000, buildingSize: 40_000,
      grossRevenue: 0, vacancyRate: 5, operatingExpenseRatio: 20,
      downPayment: 30, interestRate: 6.5, loanTerm: 25, exitCapRate: 7, holdPeriod: 5,
    };
    const r = runModel(nnnNoRent);
    expect(r.assumptions.expenseRecoveryRate).toBeGreaterThan(0);
    expect(r.operating.grossPotentialRevenue).toBeGreaterThan(0);   // recoveries alone
    expect(r.operating.breakEvenOccupancy).toBeNull();
  });
});

// ─── going-in cap rate ───────────────────────────────────────────────────────

/** An acquisition with income already in place. Gross-lease, so no recoveries. */
const acquisitionDeal = {
  propertyType: 'multifamily',
  constructionType: 'acquisition',
  location: 'Houston, TX',
  purchasePrice: 20_000_000,
  constructionCost: 2_000_000,
  buildingSize: 150_000,
  units: 180,
  grossRevenue: 3_200_000,
  vacancyRate: 6,
  operatingExpenseRatio: 35,
  downPayment: 30,
  interestRate: 6.4,
  loanTerm: 30,
  exitCapRate: 6.0,
  holdPeriod: 5,
  assumptions: { inPlaceRevenue: 2_800_000 },
};

describe('going-in cap rate', () => {
  const r = runModel(acquisitionDeal);

  it('prices day-one income against day-one basis', () => {
    const basis = 20_000_000;                       // purchase price
    const inPlaceOcc = 2_800_000 / 3_200_000;       // in-place rent over potential rent
    const stabilizedOcc = 1 - 0.06;
    // Opex is budgeted off the STABILISED revenue base and then flexed by the
    // variable share — the two moves the operating schedule makes, in that
    // order. Not struck on in-place revenue: charging 35% of what a part-leased
    // building collects makes a half-empty building look half as expensive to
    // run, which is the error the operating schedule is built to avoid. And not
    // grossed to 100% occupancy either: that charged the renovation months
    // 1/0.94 of the operating months' fixed cost for the same asset.
    const opex = 3_200_000 * 0.35 * stabilizedOcc * (0.70 + 0.30 * (inPlaceOcc / stabilizedOcc));
    const tax = basis * 0.0281;                     // Houston effective rate
    const reserve = 300 * 180;                      // multifamily reserve per unit
    const noi = 2_800_000 - opex - tax - reserve;   // gross lease: no reimbursements
    expect(r.operating.acquisitionBasis).toBe(basis);
    expect(r.operating.goingInNOI).toBeCloseTo(noi, 6);
    expect(r.operating.goingInCapRate).toBeCloseTo(noi / basis, 12);
  });

  it('nets property tax out of in-place NOI', () => {
    // A going-in cap gross of a 2.81% tax bill overstates the yield by most of
    // 200 bps. Reporting that next to yield on cost is the error this metric
    // exists to prevent, not one it is allowed to repeat.
    const grossOfTax = (2_800_000 * (1 - 0.35)) / 20_000_000;
    expect(r.operating.goingInCapRate).toBeLessThan(grossOfTax - 0.015);
  });

  it('does not move with the capital structure', () => {
    // A going-in cap rate is a property-level, unlevered yield. Folding loan
    // fees into the basis makes it move with the financing, and then levies
    // property tax on the lender's fees as well.
    const financed = runModel({ ...acquisitionDeal, financingCosts: 500_000 });
    expect(financed.operating.acquisitionBasis).toBe(20_000_000);
    expect(financed.operating.goingInCapRate).toBeCloseTo(r.operating.goingInCapRate, 12);
    const geared = runModel({ ...acquisitionDeal, downPayment: 60, interestRate: 9 });
    expect(geared.operating.goingInCapRate).toBeCloseTo(r.operating.goingInCapRate, 12);
  });

  it('bills expense reimbursements only on space that is actually let', () => {
    // Recoveries credited at full occupancy on a part-leased building can
    // exceed the entire in-place rent roll, which is how a property whose tax
    // bill alone outruns its rent came to report a positive going-in cap rate.
    const halfLeased = {
      propertyType: 'office', constructionType: 'acquisition', location: 'Houston, TX',
      purchasePrice: 20_000_000, constructionCost: 2_000_000, buildingSize: 150_000,
      grossRevenue: 4_200_000, vacancyRate: 8, operatingExpenseRatio: 30,
      downPayment: 30, interestRate: 6.4, loanTerm: 30, exitCapRate: 7, holdPeriod: 5,
      assumptions: { inPlaceRevenue: 500_000 },    // ~12% leased
    };
    const m = runModel(halfLeased);
    const occ = 500_000 / 4_200_000;
    const stabilizedOcc = 1 - 0.08;
    const opex = 4_200_000 * 0.30 * stabilizedOcc * (0.70 + 0.30 * (occ / stabilizedOcc));
    const tax = 20_000_000 * 0.0281;
    const reserve = 0.25 * 150_000;
    const recoveries = (opex + tax) * m.assumptions.expenseRecoveryRate * occ;
    expect(m.operating.goingInNOI).toBeCloseTo(500_000 + recoveries - opex - tax - reserve, 6);
    // Rent of 500,000 against a 562,000 tax bill cannot be a positive yield.
    expect(tax).toBeGreaterThan(500_000);
    expect(m.operating.goingInNOI).toBeLessThan(0);
    expect(m.operating.goingInCapRate).toBeLessThan(0);
  });

  it('is null when there is no potential rent to measure occupancy against', () => {
    const noPotential = { ...acquisitionDeal, grossRevenue: 0 };
    expect(runModel(noPotential).operating.goingInCapRate).toBeNull();
  });

  it('is null rather than a vast rate when nothing was paid for the asset', () => {
    const noPrice = { ...acquisitionDeal, purchasePrice: 0, financingCosts: 250_000 };
    expect(runModel(noPrice).operating.acquisitionBasis).toBeNull();
    expect(runModel(noPrice).operating.goingInCapRate).toBeNull();
  });

  it('excludes capital spent after day one, which yield on cost includes', () => {
    // The two metrics must move independently: renovation capital enlarges the
    // development basis without changing what was paid for the income in place.
    const heavier = runModel({ ...acquisitionDeal, constructionCost: 6_000_000 });
    expect(heavier.operating.goingInCapRate).toBeCloseTo(r.operating.goingInCapRate, 12);
    expect(heavier.operating.yieldOnCost).toBeLessThan(r.operating.yieldOnCost);
  });

  it('is not yield on cost, and does not replace it', () => {
    expect(r.operating.yieldOnCost).not.toBeNull();
    expect(r.operating.goingInCapRate)
      .not.toBeCloseTo(r.operating.stabilizedNOI / r.budget.totalProjectCost, 4);
  });

  it('is null for ground-up, where there is no in-place income to price', () => {
    // A ground-up deal has no going-in cap rate. Borrowing the stabilised
    // figure would report a cap rate on a building that does not exist yet.
    const ground = runModel({ ...acquisitionDeal, constructionType: 'groundUp' });
    expect(ground.operating.goingInCapRate).toBeNull();
    expect(ground.operating.goingInNOI).toBeNull();
    expect(ground.operating.yieldOnCost).not.toBeNull();
  });

  it('credits expense reimbursements on an NNN acquisition', () => {
    // Base rent alone understates in-place income for a net-leased asset: the
    // tenant is already repaying operating cost and tax on day one.
    const nnn = { ...acquisitionDeal, propertyType: 'retail', units: 0, expenseRecoveryRate: 0.90 };
    const gross = { ...nnn, expenseRecoveryRate: 0 };
    expect(runModel(nnn).operating.goingInCapRate)
      .toBeGreaterThan(runModel(gross).operating.goingInCapRate);
  });

  it('is null for an acquisition underwritten with no in-place income', () => {
    const vacant = { ...acquisitionDeal, assumptions: { inPlaceRevenue: 0 } };
    expect(runModel(vacant).operating.goingInCapRate).toBeNull();
  });

  it('is surfaced by calculateMetrics without disturbing yield on cost', () => {
    const m = calculateMetrics(acquisitionDeal);
    expect(m.goingInCapRate).toBeCloseTo(r.operating.goingInCapRate * 100, 9);
    expect(m.yieldOnCost).toBeCloseTo(r.operating.yieldOnCost * 100, 9);
    expect(calculateMetrics(groundUpDeal).goingInCapRate).toBeNull();
  });
});

// ─── DSCR-constrained debt sizing ────────────────────────────────────────────

describe('sizeDebt', () => {
  const terms = { annualRate: 0.065, termYears: 25 };

  it('funds the smallest of the three tests and names the one that bound', () => {
    const r = sizeDebt({ projectCost: 10_000_000, stabilizedNOI: 900_000, ...terms });
    const evaluated = Object.values(r.constraints).filter((v) => v !== null);
    expect(r.loanAmount).toBe(Math.min(...evaluated));
    expect(r.constraints[r.bindingConstraint]).toBe(r.loanAmount);
  });

  it('reports LTC as binding when coverage is abundant', () => {
    const r = sizeDebt({ projectCost: 10_000_000, stabilizedNOI: 1_800_000, ...terms });
    expect(r.bindingConstraint).toBe('ltc');
    expect(r.loanAmount).toBeCloseTo(10_000_000 * DEFAULT_DEBT_SIZING.maxLTC, 6);
  });

  it('reports coverage as binding when income is thin, and sizes to exactly the covenant', () => {
    // The distinction is the point of the function: an LTC-constrained deal is
    // fixed with more equity, a coverage-constrained deal is not fixed with
    // equity at all. Reporting only the amount hides which conversation to have.
    const noi = 600_000;
    const r = sizeDebt({ projectCost: 10_000_000, stabilizedNOI: noi, ...terms });
    expect(r.bindingConstraint).toBe('dscr');
    const debtService = amortizingPayment(r.loanAmount, terms.annualRate, terms.termYears) * 12;
    expect(noi / debtService).toBeCloseTo(DEFAULT_DEBT_SIZING.minDSCR, 9);
  });

  it('reports debt yield as binding when a long cheap amortisation flatters DSCR', () => {
    // 40 years at 4% carries far more debt per dollar of NOI than the debt
    // yield test allows; without the third test the loan is oversized.
    const noi = 700_000;
    const r = sizeDebt({ projectCost: 20_000_000, stabilizedNOI: noi, annualRate: 0.04, termYears: 40 });
    expect(r.bindingConstraint).toBe('debtYield');
    expect(noi / r.loanAmount).toBeCloseTo(DEFAULT_DEBT_SIZING.minDebtYield, 12);
  });

  it('honours firm limits passed in over the defaults', () => {
    const r = sizeDebt({ projectCost: 10_000_000, stabilizedNOI: 1_800_000, ...terms, maxLTC: 0.55 });
    expect(r.loanAmount).toBeCloseTo(5_500_000, 6);
    expect(r.bindingConstraint).toBe('ltc');
  });

  it('supports no debt at all when there is no coverage to lend against', () => {
    const r = sizeDebt({ projectCost: 10_000_000, stabilizedNOI: -50_000, ...terms });
    expect(r.loanAmount).toBe(0);
    expect(r.bindingConstraint).toBe('dscr');
  });

  it('reads a leverage ceiling of zero as a policy of no debt, not as an absent test', () => {
    // A firm that lends nothing has a measured limit of zero. Treating it as
    // unevaluable drops the LTC test entirely and funds whatever coverage
    // allows — an 89% LTC loan on a policy that says none.
    const r = sizeDebt({ projectCost: 10_000_000, stabilizedNOI: 900_000, ...terms, maxLTC: 0 });
    expect(r.constraints.ltc).toBe(0);
    expect(r.loanAmount).toBe(0);
    expect(r.bindingConstraint).toBe('ltc');
    // ...and no discontinuity at the boundary: an epsilon of leverage must fund
    // an epsilon of loan, not five million dollars.
    const sliver = sizeDebt({ projectCost: 10_000_000, stabilizedNOI: 900_000, ...terms, maxLTC: 1e-4 });
    expect(sliver.loanAmount).toBeCloseTo(1_000, 6);
  });

  it('sizes coverage to the worst covenant year, not the first one', () => {
    // Expense growth outrunning rent growth makes year one the best year the
    // deal ever has. A loan sized on it breaches its own covenant in year two.
    const coverage = [
      { noi: 1_000_000, debtServicePerDollar: 0.08 },
      { noi: 900_000, debtServicePerDollar: 0.08 },   // the year the covenant bites
      { noi: 950_000, debtServicePerDollar: 0.08 },
    ];
    const r = sizeDebt({ projectCost: 100_000_000, coverage, stabilizedNOI: 1_000_000, ...terms });
    expect(r.bindingConstraint).toBe('dscr');
    expect(r.loanAmount).toBeCloseTo(900_000 / (DEFAULT_DEBT_SIZING.minDSCR * 0.08), 6);
    for (const year of coverage) {
      expect(year.noi / (r.loanAmount * year.debtServicePerDollar))
        .toBeGreaterThanOrEqual(DEFAULT_DEBT_SIZING.minDSCR - 1e-9);
    }
  });

  it('prices coverage off the debt service each year actually charges', () => {
    // An interest-only year and an amortising year are different tests on the
    // same loan. Pricing every year off the amortising payment undersizes a
    // loan that is still interest-only where the covenant is measured.
    const interestOnlyYear = { noi: 900_000, debtServicePerDollar: 0.065 };
    const amortisingYear = { noi: 900_000, debtServicePerDollar: 0.081 };
    const io = sizeDebt({ projectCost: 100_000_000, coverage: [interestOnlyYear], stabilizedNOI: 900_000, ...terms });
    const amort = sizeDebt({ projectCost: 100_000_000, coverage: [amortisingYear], stabilizedNOI: 900_000, ...terms });
    expect(io.loanAmount).toBeGreaterThan(amort.loanAmount);
    expect(io.loanAmount).toBeCloseTo(900_000 / (DEFAULT_DEBT_SIZING.minDSCR * 0.065), 6);
  });

  it('returns null, not zero, for a constraint it cannot evaluate', () => {
    // Zero and unknown are different claims: a zero here would bind and size
    // the loan to nothing, an Infinity would silently drop the test.
    const noNoi = sizeDebt({ projectCost: 10_000_000, ...terms });
    expect(noNoi.constraints.dscr).toBeNull();
    expect(noNoi.constraints.debtYield).toBeNull();
    expect(noNoi.bindingConstraint).toBe('ltc');

    const noTerm = sizeDebt({ projectCost: 10_000_000, stabilizedNOI: 600_000, annualRate: 0.065, termYears: 0 });
    expect(noTerm.constraints.dscr).toBeNull();

    const nothing = sizeDebt({});
    expect(nothing.loanAmount).toBeNull();
    expect(nothing.bindingConstraint).toBeNull();
  });
});

describe('debt sized to constraints, wired into the model', () => {
  const geared = { ...groundUpDeal, downPayment: 8 };

  it('leaves the equity-percentage path untouched unless asked', () => {
    expect(runModel(geared)).toEqual(runModel({ ...geared, sizeDebtToConstraints: false }));
    expect(runModel(geared).financing.sizing).toBeNull();
    expect(runModel(geared).financing.loanCommitment)
      .toBeCloseTo(runModel(geared).budget.baseProjectCost * 0.92, 6);
  });

  it('resizes an over-levered deal down to the binding constraint', () => {
    const sized = runModel({ ...geared, sizeDebtToConstraints: true });
    expect(sized.financing.sizing.bindingConstraint).not.toBeNull();
    expect(sized.financing.loanCommitment).toBeLessThan(runModel(geared).financing.loanCommitment);
    expect(sized.financing.equityCommitment).toBeGreaterThan(0);
  });

  it('funds the sized amount as the permanent balance the covenants are tested on', () => {
    // Sizing the commitment instead would fund the target PLUS the interest
    // capitalised during construction, breaching every limit it was sized to.
    const sized = runModel({ ...geared, sizeDebtToConstraints: true });
    expect(sized.financing.sizing.converged).toBe(true);
    expect(sized.financing.permanentLoanBalance)
      .toBeCloseTo(sized.financing.sizing.loanAmount, 0);
    expect(sized.budget.capitalizedInterest).toBeGreaterThan(0);
  });

  it('produces a deal that clears the same credit box it was sized to', () => {
    const sized = runModel({ ...geared, sizeDebtToConstraints: true });
    const ids = validate(sized, geared).map((f) => f.id);
    expect(ids).not.toContain('ltc');
    expect(ids).not.toContain('dscr');
    expect(ids).not.toContain('debtYield');
    expect(validate(runModel(geared), geared).map((f) => f.id)).toContain('ltc');
  });

  it('tells the analyst whether the deal is LTC- or coverage-constrained', () => {
    const strongIncome = runModel({ ...groundUpDeal, sizeDebtToConstraints: true });
    expect(strongIncome.financing.sizing.bindingConstraint).toBe('ltc');
    expect(strongIncome.operating.stabilizedDSCR).toBeGreaterThan(DEFAULT_DEBT_SIZING.minDSCR);

    // Halve the revenue and coverage, not cost, becomes the limit.
    const thinIncome = runModel({ ...groundUpDeal, grossRevenue: 300_000, sizeDebtToConstraints: true });
    expect(thinIncome.financing.sizing.bindingConstraint).not.toBe('ltc');
    expect(thinIncome.financing.loanCommitment)
      .toBeLessThan(strongIncome.financing.loanCommitment);
  });

  it('honours per-deal sizing limits', () => {
    const tight = runModel({ ...geared, sizeDebtToConstraints: true, debtSizing: { maxLTC: 0.45 } });
    expect(tight.financing.sizing.bindingConstraint).toBe('ltc');
    // Sized to the limit and reported on the same basis it was sized against,
    // so the deal lands on the box rather than near it.
    expect(tight.financing.ltc).toBeCloseTo(0.45, 6);
    expect(validate(tight, tight).map((f) => f.id)).not.toContain('ltc');
  });

  it('clears the covenant in every stabilized year, not only the first', () => {
    // Expense growth above rent growth makes NOI fall year on year, so the
    // minimum stabilized coverage — the figure the covenant is tested against —
    // is not year one. A loan sized on year one is in breach the day it funds.
    const declining = {
      ...groundUpDeal, grossRevenue: 300_000, downPayment: 8,
      assumptions: { rentGrowth: 0.01 },   // below the module's own growth ceiling
    };
    const sized = runModel({ ...declining, sizeDebtToConstraints: true });
    expect(sized.financing.sizing.bindingConstraint).toBe('dscr');
    expect(sized.operating.minStabilizedDSCR).toBeLessThan(sized.operating.stabilizedDSCR);
    // The fixed point settles within a dollar of the constraint, which is a
    // part in a million of coverage — the tolerance validate() already allows.
    expect(sized.operating.minStabilizedDSCR).toBeCloseTo(DEFAULT_DEBT_SIZING.minDSCR, 5);
    expect(validate(sized, declining).map((f) => f.id)).not.toContain('dscr');
  });

  it('sizes against the debt service the model charges during an interest-only window', () => {
    // With interest-only running past stabilization the covenant is measured on
    // interest alone. Sizing off the amortising payment undersizes the loan and
    // reports a 1.25x DSCR next to a schedule showing 1.53x.
    const io = {
      ...groundUpDeal, grossRevenue: 300_000, downPayment: 8,   // thin enough that coverage binds
      assumptions: { interestOnlyMonths: 36 },
    };
    const sized = runModel({ ...io, sizeDebtToConstraints: true });
    expect(sized.financing.sizing.bindingConstraint).toBe('dscr');
    expect(sized.operating.stabilizedDebtService).toBeLessThan(sized.financing.annualDebtService);
    expect(sized.operating.minStabilizedDSCR).toBeCloseTo(DEFAULT_DEBT_SIZING.minDSCR, 5);
    // Sized off the amortising payment the model never charges in that window,
    // the loan comes in about a fifth smaller than coverage supports.
    const amortisingPaymentBasis = sized.operating.stabilizedNOI
      / (DEFAULT_DEBT_SIZING.minDSCR * amortizingPayment(1, 0.068, 25) * 12);
    expect(sized.financing.sizing.loanAmount).toBeGreaterThan(amortisingPaymentBasis * 1.05);
  });

  it('reports leverage on the basis it was sized against', () => {
    // The interest reserve is borrowed money spent on the project. Measuring
    // the commitment net of it against a cost base that also excludes it
    // reports 70.0% on a deal funded at 70.9%, and the binding constraint the
    // sizer names then reconciles to nothing the model returns.
    const sized = runModel({ ...geared, sizeDebtToConstraints: true, debtSizing: { maxLTC: 0.60 } });
    expect(sized.financing.ltc)
      .toBeCloseTo(sized.financing.permanentLoanBalance / sized.budget.totalProjectCost, 12);
    expect(sized.budget.capitalizedInterest).toBeGreaterThan(0);
    expect(sized.financing.ltc).toBeCloseTo(0.60, 6);
  });

  it('funds a project with no construction period at closing', () => {
    // The draw loop runs `for (i = 0; i < C; i++)`, so a zero-month project
    // never entered it: nothing was funded, no equity was drawn, the permanent
    // balance was zero and the schedule showed an asset acquired for free —
    // with an IRR of null beside it. A stabilised acquisition is the obvious
    // next construction type and lands exactly here.
    const standing = {
      propertyType: 'retail', constructionType: 'acquisition', location: 'Tampa, FL',
      purchasePrice: 6_400_000, constructionCost: 0, buildingSize: 18_000,
      grossRevenue: 558_000, vacancyRate: 6, operatingExpenseRatio: 20,
      downPayment: 30, interestRate: 6.4, loanTerm: 25, exitCapRate: 7, holdPeriod: 5,
      constructionMonths: 0,
    };
    const r = runModel(standing);
    expect(r.timeline.constructionMonths).toBe(0);
    expect(r.financing.permanentLoanBalance).toBeCloseTo(r.financing.loanCommitment, 6);
    expect(r.financing.permanentLoanBalance).toBeGreaterThan(0);
    // The equity goes in at closing, and it is the only negative equity flow.
    expect(r.months[0].equityDraw).toBeCloseTo(r.financing.equityCommitment, 6);
    expect(r.months.filter((m) => m.equityDraw > 0)).toHaveLength(1);
    // Peak equity is the closing cheque plus whatever the asset fails to cover
    // while it lets up, so it is at least the commitment and never less.
    expect(r.returns.peakEquity).toBeGreaterThanOrEqual(r.financing.equityCommitment - 0.5);
    expect(r.months[0].equityFlow)
      .toBeCloseTo(r.months[0].cashFlow - r.financing.equityCommitment, 6);
    expect(r.returns.leveredIRR).not.toBeNull();
    // Nothing is borrowed for interest when there is no construction to carry.
    expect(r.budget.capitalizedInterest).toBe(0);
    expect(r.financing.ltc).toBeCloseTo(0.70, 9);
  });

  it('reports an unmodelled deal as unknown rather than as zero', () => {
    // `incomplete: true` is easy to miss; the numbers beside it are not. A
    // stabilized NOI of 0 and a peak equity of 0 read as measured answers —
    // no income, nothing at risk — on a deal that was never modelled at all.
    const r = runModel({ purchasePrice: 1_000_000, holdPeriod: 0 });
    expect(r.incomplete).toBe(true);
    for (const key of ['stabilizedNOI', 'stabilizedDebtService', 'grossPotentialRevenue', 'stabilizedOutgoings']) {
      expect(r.operating[key]).toBeNull();
    }
    for (const key of ['peakEquity', 'profit', 'totalEquityInvested', 'totalDistributions']) {
      expect(r.returns[key]).toBeNull();
    }
    const m = calculateMetrics({ purchasePrice: 1_000_000, holdPeriod: 0 });
    expect(m.cashFlow).toBeNull();
    expect(m.cashOnCash).toBeNull();
  });

  it('reports the debt and the exit of an unmodelled deal as unknown too', () => {
    // The same rule, on the fields that were still answering zero. A permanent
    // balance of 0 is not "borrowed nothing", it is "never drew a schedule" —
    // and it sat beside a loan commitment the equity share had already filled
    // in, so the pair contradicted each other. One screen papered over it by
    // testing `model.incomplete` before printing the balance, which is a caller
    // doing the engine's job; the CSV and the memo had no such guard.
    const r = runModel({ purchasePrice: 1_000_000, holdPeriod: 0 });
    expect(r.financing.loanCommitment).toBeGreaterThan(0);
    for (const key of ['permanentLoanBalance', 'monthlyPayment', 'annualDebtService', 'ltc', 'gpCoInvest', 'lpEquity']) {
      expect(r.financing[key]).toBeNull();
    }
    for (const key of ['forwardNoi', 'grossSalePrice', 'costOfSale', 'loanPayoff', 'netSaleProceeds']) {
      expect(r.exit[key]).toBeNull();
    }
    // ...but the exit cap rate is a pure pass-through INPUT, echoed unchanged on
    // the normal path, so it is known here for the same reason the land basis
    // below is. Nulling it applied the rule in both directions at once.
    expect(r.exit.exitCapRate).toBe(6.5);
    // The interest reserve was never accumulated, so neither it nor the total
    // cost that contains it is known. The capital plan IS known — it is an
    // input, and it was computed before the engine decided the deal could not
    // be scheduled. Reporting a million-dollar land basis as $0 is the same
    // conflation of zero with unknown, pointed the other way.
    expect(r.budget.baseProjectCost).toBeGreaterThan(0);
    expect(r.budget.land).toBe(1_000_000);
    expect(r.budget.capitalizedInterest).toBeNull();
    expect(r.budget.totalProjectCost).toBeNull();
    // ...and no sources & uses table, because every surface renders its rows as
    // a share of a total development cost that is genuinely unknown here.
    expect(r.budget.lines).toEqual([]);
    // Months into a schedule that does not exist. Month 0 is the closing, so a
    // 0 here names a real month rather than an absent one.
    expect(r.operating.stabilizationMonth).toBeNull();
    expect(r.operating.interestOnlyMonths).toBeNull();
    expect(r.timeline.leaseUpMonths).toBeNull();
    expect(r.timeline.saleMonth).toBeNull();
    // The hold and construction lengths are inputs, and one of them being zero
    // is the reason this path was taken at all.
    expect(r.timeline.operatingMonths).toBe(0);
  });

  it('still returns an incomplete model rather than sizing an unmodellable deal', () => {
    const r = runModel({ sizeDebtToConstraints: true });
    expect(r.incomplete).toBe(true);
  });

  it('says in the model whether the sizing flag was actually honoured', () => {
    // The named failure: with no lender test evaluable the sizing loop breaks
    // on its first pass and the model returned is the UNSIZED one — a loan
    // derived from the equity share, carried under a sizeDebtToConstraints
    // flag, with a fully populated loanCommitment beside a null sizing amount.
    // Nothing in the model marked the flag unhonoured, so every surface
    // inferred it from that null and they did not agree.
    const untestable = {
      ...geared, sizeDebtToConstraints: true,
      debtSizing: { maxLTC: Number.NaN, minDSCR: 0, minDebtYield: 0 },
    };
    const unhonoured = runModel(untestable);
    expect(unhonoured.financing.sizingRequested).toBe(true);
    expect(unhonoured.financing.sizing.honoured).toBe(false);
    expect(unhonoured.financing.sizing.loanAmount).toBeNull();
    // ...and the loan it carries is exactly the equity-share loan, which is the
    // fact `honoured: false` exists to disclose.
    expect(unhonoured.financing.loanCommitment)
      .toBeCloseTo(runModel({ ...geared }).financing.loanCommitment, 6);

    const honoured = runModel({ ...geared, sizeDebtToConstraints: true });
    expect(honoured.financing.sizingRequested).toBe(true);
    expect(honoured.financing.sizing.honoured).toBe(true);
    expect(honoured.financing.loanCommitment)
      .toBeLessThan(unhonoured.financing.loanCommitment);
  });

  it('distinguishes a deal that never asked for constrained sizing from one that asked in vain', () => {
    // Three states, and before this the model expressed two of them. A caller
    // reaching back to the deal record for the third is a caller guessing.
    const neverAsked = runModel(geared);
    expect(neverAsked.financing.sizingRequested).toBe(false);
    expect(neverAsked.financing.sizing).toBeNull();

    // Asked, but the model never reached a schedule to size against.
    const noSchedule = runModel({ ...geared, sizeDebtToConstraints: true, holdPeriod: 0 });
    expect(noSchedule.incomplete).toBe(true);
    expect(noSchedule.financing.sizingRequested).toBe(true);
    expect(noSchedule.financing.sizing).toBeNull();
  });

  it('does not report an unconverged loop as an unapplied constraint, or the reverse', () => {
    // `converged` and `honoured` answer different questions: whether the fixed
    // point settled, and whether a lender test sized the loan at all. A loan
    // that no test could size was being described as one that merely had not
    // settled, which reads as a near-miss rather than as no sizing at all.
    const sized = runModel({ ...geared, sizeDebtToConstraints: true });
    expect(sized.financing.sizing.converged).toBe(true);
    expect(sized.financing.sizing.honoured).toBe(true);

    const untestable = runModel({
      ...geared, sizeDebtToConstraints: true,
      debtSizing: { maxLTC: Number.NaN, minDSCR: 0, minDebtYield: 0 },
    });
    expect(untestable.financing.sizing.converged).toBe(false);
    expect(untestable.financing.sizing.honoured).toBe(false);
    expect(untestable.financing.sizing.bindingConstraint).toBeNull();
  });
});

// ─── validation of the new metrics ───────────────────────────────────────────

describe('validation of break-even occupancy and rent growth', () => {
  it('flags a break-even occupancy above the committee limit', () => {
    const geared = { ...groundUpDeal, downPayment: 12, interestRate: 8.5, operatingExpenseRatio: 45 };
    const model = runModel(geared);
    const flag = validate(model, geared).find((f) => f.id === 'breakEvenOccupancy');
    expect(model.operating.breakEvenOccupancy).toBeGreaterThan(0.80);
    expect(flag).toBeDefined();
    expect(flag.severity).toBe('warning');
    expect(flag.field).toBe('vacancyRate');
    // And this is why the flag earns its place: coverage clears the covenant
    // comfortably while the asset is six points of occupancy from bleeding.
    expect(model.operating.stabilizedDSCR).toBeGreaterThan(1.25);
    expect(validate(model, geared).find((f) => f.id === 'dscr')).toBeUndefined();
  });

  it('escalates to an error when outgoings are not covered at the occupancy underwritten', () => {
    const broken = { ...groundUpDeal, downPayment: 5, interestRate: 12, operatingExpenseRatio: 55 };
    const model = runModel(broken);
    expect(model.operating.breakEvenOccupancy)
      .toBeGreaterThanOrEqual(model.operating.stabilizedOccupancy);
    expect(validate(model, broken).find((f) => f.id === 'breakEvenOccupancy').severity).toBe('error');
  });

  it('flags a break-even above the occupancy underwritten even when it sits under the ceiling', () => {
    // The failure this guards: the escalation used to be nested inside the
    // ceiling test, so an underwriting whose own occupancy was already below
    // break-even raised nothing at all as long as break-even stayed under 80%.
    // That silenced the rule on precisely the deals it exists for.
    const empty = { ...groundUpDeal, vacancyRate: 60 };
    const model = runModel(empty);
    expect(model.operating.breakEvenOccupancy).toBeLessThan(0.80);
    expect(model.operating.stabilizedOccupancy).toBeLessThan(model.operating.breakEvenOccupancy);
    expect(model.operating.stabilizedDSCR).toBeLessThan(1);
    const flag = validate(model, empty).find((f) => f.id === 'breakEvenOccupancy');
    expect(flag).toBeDefined();
    expect(flag.severity).toBe('error');
  });

  it('does not flag a deal with room between break-even and underwritten occupancy', () => {
    const comfortable = { ...groundUpDeal, downPayment: 45 };
    const model = runModel(comfortable);
    expect(model.operating.breakEvenOccupancy).toBeLessThan(0.80);
    expect(validate(model, comfortable).find((f) => f.id === 'breakEvenOccupancy')).toBeUndefined();
  });

  it('flags rent growth above the ceiling and leaves the ceiling itself alone', () => {
    const aggressive = { ...groundUpDeal, assumptions: { rentGrowth: 0.045 } };
    const flag = validate(runModel(aggressive), aggressive).find((f) => f.id === 'rentGrowth');
    expect(flag).toBeDefined();
    expect(flag.field).toBe('rentGrowth');
    expect(flag.severity).toBe('warning');

    // Exactly at the ceiling is compliant; the firm default sits on it.
    const atCeiling = { ...groundUpDeal, assumptions: { rentGrowth: 0.03 } };
    expect(validate(runModel(atCeiling), atCeiling).find((f) => f.id === 'rentGrowth')).toBeUndefined();
  });

  it('honours a firm-specific rent growth ceiling', () => {
    const flags = validate(runModel(groundUpDeal), groundUpDeal, { maxRentGrowth: 0.02 });
    expect(flags.find((f) => f.id === 'rentGrowth')).toBeDefined();
  });
});

describe('break-even verdict has one definition', () => {
  it('never flags a deal the shared verdict calls clean, or the reverse', () => {
    // The Deal Model tile used to reimplement the CEILING test alone, so it
    // printed "clears" with no negative tone on deals where validate() raised
    // an error — a break-even 12 points above the occupancy the deal itself
    // underwrites still sits under an 80% ceiling. In Grid posture the flag
    // list is hidden and the tile is the only break-even statement on screen.
    // Both now read breakEvenBreach(), and this sweep is what keeps them there.
    const disagreements = [];
    for (const deal of SAMPLE_DEALS) {
      for (const vacancyRate of [5, 10, 15, 20, 25, 30, 35]) {
        for (const holdPeriod of [1, 3, 5, 7]) {
          const candidate = { ...deal, vacancyRate, holdPeriod };
          const model = runModel(candidate);
          if (model.incomplete) continue;
          const verdict = breakEvenBreach(model.operating);
          const flagged = validate(model, candidate)
            .some((f) => f.id === 'breakEvenOccupancy');
          if (verdict.breached !== flagged) {
            disagreements.push([deal.name, vacancyRate, holdPeriod, verdict.breached, flagged]);
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('fires on a break-even above underwritten occupancy that is still under the ceiling', () => {
    // The exact configuration the ceiling-only test missed: break-even between
    // the underwritten occupancy and the firm's ceiling, so only the cushion
    // test can catch it. The fixture is tuned to sit in that band and was
    // re-tuned when the renovation period began carrying tax, reserves and
    // fixed opex on a deal bought empty — that carry capitalises more interest,
    // which enlarges basis and the tax struck on it, and pushed break-even past
    // 0.80 where the ceiling test would have covered for the cushion test. The
    // invariant under test is unchanged; the numbers that isolate it are not.
    const deal = {
      name: 'No cushion', propertyType: 'multifamily', constructionType: 'acquisition',
      location: 'Dallas, TX', purchasePrice: 12_000_000, constructionCost: 2_000_000,
      buildingSize: 200_000, grossRevenue: 2_800_000, vacancyRate: 33,
      operatingExpenseRatio: 35, downPayment: 40, interestRate: 6.2, loanTerm: 30,
      exitCapRate: 6.5, holdPeriod: 5,
    };
    const v = breakEvenBreach(runModel(deal).operating);
    expect(v.overCeiling).toBe(false);       // under the 80% ceiling
    expect(v.noCushion).toBe(true);          // and above the occupancy underwritten
    expect(v.breached).toBe(true);
    expect(validate(runModel(deal), deal).some((f) => f.id === 'breakEvenOccupancy')).toBe(true);
  });

  it('reports no cushion rather than a cushion of zero when occupancy is unknown', () => {
    const v = breakEvenBreach({ breakEvenOccupancy: 0.7, stabilizedOccupancy: null });
    expect(v.cushion).toBeNull();
    const none = breakEvenBreach({ breakEvenOccupancy: null, stabilizedOccupancy: 0.95 });
    expect(none.breached).toBe(false);
    expect(none.cushion).toBeNull();
  });
});

describe('non-finite inputs', () => {
  // The degenerate guard tested `N === 0 || baseProjectCost <= 0`, and NaN
  // satisfies neither: every comparison against NaN is false. A deal carrying
  // one therefore ran the whole schedule and came back `incomplete: false`.
  const base = {
    propertyType: 'multifamily', constructionType: 'groundUp', location: 'Dallas, TX',
    purchasePrice: 1_000_000, constructionCost: 5_000_000, units: 50,
    grossRevenue: 900_000, holdPeriod: 5, exitCapRate: 6.0,
  };

  it('reports a NaN input as unmodelled rather than as a confident zero', () => {
    const r = runModel({ ...base, holdPeriod: NaN });
    expect(r.incomplete).toBe(true);
    // These were the values it returned instead: no NOI, no equity multiple,
    // a -650 bps development spread and a $7.8m loss, all stated as measured.
    for (const key of ['stabilizedNOI', 'yieldOnCost', 'developmentSpreadBps', 'breakEvenOccupancy']) {
      expect(r.operating[key]).toBeNull();
    }
    for (const key of ['equityMultiple', 'profit', 'peakEquity', 'leveredIRR']) {
      expect(r.returns[key]).toBeNull();
    }
    expect(r.exit.grossSalePrice).toBeNull();
    expect(r.months).toEqual([]);
    // A NaN hold period is not a known hold period either: it reports as
    // unknown, not as the NaN that produced it.
    expect(r.timeline.operatingMonths).toBeNull();
    expect(r.timeline.saleMonth).toBeNull();
  });

  it('never reports a non-finite figure, whichever input is not a number', () => {
    // The invariant is not "always incomplete" — a negative purchase price is
    // clamped to zero, which is a real reading of the input. It is that no
    // reported figure is ever NaN or Infinity, however the deal arrives.
    const nonFinite = [];
    const walk = (o, path) => {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'number' && !Number.isFinite(v)) nonFinite.push(`${path}${k}`);
        else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${path}${k}.`);
      }
    };
    for (const field of ['purchasePrice', 'constructionCost', 'grossRevenue', 'vacancyRate',
                         'operatingExpenseRatio', 'interestRate', 'loanTerm', 'exitCapRate',
                         'downPayment', 'holdPeriod', 'propertyTaxRate', 'buildingSize', 'units']) {
      for (const bad of [NaN, Infinity, -Infinity]) {
        const r = runModel({ ...base, [field]: bad });
        for (const section of ['budget', 'financing', 'exit', 'returns', 'operating', 'timeline']) {
          walk(r[section], `${field}=${bad} ${section}.`);
        }
      }
    }
    expect(nonFinite).toEqual([]);
  });

  it('never emits a NaN in a reported figure, whatever the input', () => {
    const r = runModel({ ...base, constructionCost: NaN });
    const walk = (o, path = '') => {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'number') expect([`${path}${k}`, Number.isFinite(v)]).toEqual([`${path}${k}`, true]);
        else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${path}${k}.`);
      }
    };
    for (const section of ['budget', 'financing', 'exit', 'returns', 'operating', 'timeline']) {
      walk(r[section], `${section}.`);
    }
  });

  it('flags the unmodelled deal instead of screening it as a failure', () => {
    // `incomplete: false` meant validate() raised nothing (its incomplete rule
    // never fired) and screeningVerdict() printed an affirmative "does not meet
    // stated criteria" naming four failed tests, about a model never computed.
    const r = runModel({ ...base, constructionCost: NaN });
    expect(validate(r, base).some((f) => /incomplete|not been modell?ed|cannot be/i.test(f.message ?? ''))
      || validate(r, base).length > 0).toBe(true);
  });

  it('does not turn an absent construction cost into NaN in a scenario', () => {
    // applyScenario scaled `undefined * 1.1`, and every memo runs the Downside
    // scenario. A legitimate pure acquisition came back from it uncomputed.
    const acquisition = {
      constructionType: 'acquisition', propertyType: 'office', location: 'Dallas, TX',
      constructionMonths: 0, purchasePrice: 8_000_000, buildingSize: 60_000,
      grossRevenue: 700_000, holdPeriod: 5, exitCapRate: 6.5,
    };
    const scenarios = runScenarios(acquisition);
    for (const s of scenarios) {
      expect([s.label ?? s.key, s.model.incomplete]).toEqual([s.label ?? s.key, undefined]);
      expect(Number.isFinite(s.model.budget.totalProjectCost)).toBe(true);
    }
  });
});
