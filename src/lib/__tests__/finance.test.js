import {
  amortizingPayment,
  irr,
  annualize,
  npv,
  runModel,
  calculateMetrics,
  DEFAULT_ASSUMPTIONS,
} from '../finance';
import { suggestGrossRevenue, suggestConstructionCost } from '../propertyTypes';
import { getPropertyTaxRate, resolveTaxRate, findMarket, distanceMiles } from '../markets';

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
  it('services construction-period interest from in-place income', () => {
    const withIncome = runModel({
      ...groundUpDeal,
      constructionType: 'acquisition',
      assumptions: { inPlaceRevenue: 400_000 },
    });
    const without = runModel({ ...groundUpDeal, constructionType: 'acquisition' });
    // Income during renovation reduces the interest that must be capitalised.
    expect(withIncome.budget.capitalizedInterest).toBeLessThan(without.budget.capitalizedInterest);
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
