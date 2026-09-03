/**
 * Tests for four underwriting-policy changes in finance.js:
 *
 *   1. The fixed operating expense base is anchored to the HOUSE vacancy for
 *      the property type, never to the deal's own.
 *   2. Ground-up deals carry construction-period property tax on the land as an
 *      explicit budget line, with the ground-up soft cost load relieved of the
 *      carry it was standing in for.
 *   3. The IRR solver reports whether its answer is the only rate that zeroes
 *      the NPV.
 *   4. The equity commitment is struck on TOTAL project cost, which is the
 *      basis the loan-to-cost covenant tests against.
 *
 * Every figure asserted here is priced from the inputs, independently of the
 * engine, or is a relationship between two engine runs. Nothing compares the
 * engine to itself.
 */

import {
  runModel, irr, npv, countSignChanges, irrWithDiagnostics, DEFAULT_ASSUMPTIONS,
} from '../finance';
import { propertyTypes, constructionTypes } from '../propertyTypes';
import { FIRM_DEFAULTS, firmDefault } from '../firmDefaults';
import { getPropertyTaxRate } from '../markets';
import { SAMPLE_DEALS } from '../sampleDeals';
import { validate, DEFAULT_COVENANTS } from '../validation';

const VARIABLE_SHARE = DEFAULT_ASSUMPTIONS.variableOpexShare;   // 0.30
const FIXED_SHARE = 1 - VARIABLE_SHARE;

const houseOccFor = (propertyType) =>
  1 - (firmDefault('vacancyRate', propertyType) ?? 5) / 100;

/** The stabilized twelve months of a model, and a summer over one field. */
function stabilizedWindow(r) {
  const start = r.operating.stabilizationMonth;
  const window = r.months.slice(start, start + 12);
  return { window, sum: (k) => window.reduce((s, m) => s + (m[k] || 0), 0) };
}

// ─── 1. the operating expense base ───────────────────────────────────────────

describe('operating expense base is anchored to house vacancy', () => {
  it.each(SAMPLE_DEALS.map((d) => [d.name, d]))(
    '%s at its house vacancy budgets exactly the opex the old convention did',
    (_name, deal) => {
      // THE COMPATIBILITY CLAIM, deal by deal on all nine samples. The previous
      // convention was `opexAtFullOccupancy x stabilizedOcc` flexed by the
      // variable share; at the house vacancy the anchor IS the stabilised
      // occupancy, so the two must agree to the cent. If this drifts, the
      // change stopped being a re-anchoring and became a re-pricing.
      const houseVacancy = firmDefault('vacancyRate', deal.propertyType) ?? 5;
      const atHouse = runModel({ ...deal, vacancyRate: houseVacancy });
      const stabilizedOcc = 1 - houseVacancy / 100;
      const { window } = stabilizedWindow(atHouse);

      expect(window).toHaveLength(12);
      for (const m of window) {
        // Priced from the inputs: the ratio on potential revenue, escalated to
        // the month, then taken at stabilised occupancy — the OLD formula.
        const yr = (m.index - atHouse.timeline.constructionMonths) / 12;
        const atFull = (deal.grossRevenue / 12)
          * (deal.operatingExpenseRatio / 100)
          * Math.pow(1 + DEFAULT_ASSUMPTIONS.expenseGrowth, yr);
        expect(m.occ).toBeCloseTo(stabilizedOcc, 12);
        expect(m.opex).toBeCloseTo(atFull * stabilizedOcc, 6);
      }
    },
  );

  it('holds the fixed component identical across two vacancy assumptions', () => {
    // The whole finding: the roof, the insurance, the property manager and the
    // payroll do not get cheaper because the analyst typed a higher vacancy
    // number. Opex is linear in occupancy; the SLOPE is the variable share and
    // the INTERCEPT is the fixed cost. Under the old convention the intercept
    // moved with the deal's vacancy — a 15%-vacancy building budgeted 15% less
    // fixed cost than the identical building at 5%, at every month of the hold.
    const base = {
      propertyType: 'office', constructionType: 'groundUp', location: 'Dallas, TX',
      purchasePrice: 4_000_000, constructionCost: 20_000_000, buildingSize: 100_000,
      grossRevenue: 3_000_000, operatingExpenseRatio: 30,
      downPayment: 30, interestRate: 6.4, loanTerm: 25, exitCapRate: 7.5, holdPeriod: 5,
      assumptions: { rentGrowth: 0, expenseGrowth: 0, leaseUpMonths: 0 },
    };
    const tight = runModel({ ...base, vacancyRate: 5 });
    const loose = runModel({ ...base, vacancyRate: 20 });
    const monthlyAtFull = (3_000_000 / 12) * 0.30;

    const t = tight.months[tight.operating.stabilizationMonth];
    const l = loose.months[loose.operating.stabilizationMonth];
    const intercept = (m) => m.opex - VARIABLE_SHARE * monthlyAtFull * m.occ;

    expect(t.occ).toBeCloseTo(0.95, 12);
    expect(l.occ).toBeCloseTo(0.80, 12);
    // Same intercept, to the cent, on two deals fifteen points apart.
    expect(intercept(t)).toBeCloseTo(intercept(l), 9);
    // ...and it is the house occupancy for office (10% vacancy) that sets it,
    // not either deal's own.
    expect(intercept(t)).toBeCloseTo(FIXED_SHARE * monthlyAtFull * houseOccFor('office'), 9);
  });

  it('makes a vacancy sensitivity bite the fixed cost', () => {
    // The Sensitivity screen is where the old convention did its damage:
    // dragging vacancy up understated the NOI hit because 70% of the expense
    // line obligingly fell with it. The marginal cost of a point of vacancy is
    // now ONLY the variable share; it used to be the whole ratio.
    const base = {
      propertyType: 'carwash', constructionType: 'groundUp', location: 'Houston, TX',
      purchasePrice: 1_000_000, constructionCost: 4_000_000, buildingSize: 5_000,
      grossRevenue: 1_500_000, operatingExpenseRatio: 45,
      downPayment: 30, interestRate: 6.8, loanTerm: 25, exitCapRate: 7.2, holdPeriod: 5,
      assumptions: { rentGrowth: 0, expenseGrowth: 0, leaseUpMonths: 0 },
    };
    const opexAt = (v) => {
      const r = runModel({ ...base, vacancyRate: v });
      return stabilizedWindow(r).sum('opex');
    };
    const annualAtFull = 1_500_000 * 0.45;
    // Ten points of vacancy now costs only the variable share of ten points.
    expect(opexAt(5) - opexAt(15)).toBeCloseTo(VARIABLE_SHARE * annualAtFull * 0.10, 4);
    // Under the old convention the same ten points removed the WHOLE ratio's
    // worth of budget, which is 3.33x as much cost falling away.
    expect(opexAt(5) - opexAt(15)).toBeLessThan(annualAtFull * 0.10 * 0.999);
  });

  it('applies the same anchor to the renovation-period opex', () => {
    // The renovation-period figure was deliberately built to mirror this
    // convention, so both had to move together or they diverge again. It now
    // shares one function with the operating schedule, and the visible
    // consequence is that the renovation opex does not move with the deal's
    // vacancy at all — the in-place occupancy is what the rent roll says, and
    // the fixed base is what the house says.
    const base = {
      propertyType: 'office', constructionType: 'acquisition', location: 'Plano, TX',
      purchasePrice: 20_000_000, constructionCost: 3_000_000, buildingSize: 150_000,
      grossRevenue: 4_000_000, operatingExpenseRatio: 30,
      downPayment: 30, interestRate: 6.4, loanTerm: 25, exitCapRate: 8, holdPeriod: 5,
      assumptions: { inPlaceRevenue: 2_000_000 },
    };
    const inPlaceOcc = 2_000_000 / 4_000_000;
    const expected = 4_000_000 * 0.30
      * (FIXED_SHARE * houseOccFor('office') + VARIABLE_SHARE * inPlaceOcc) / 12;

    for (const vacancyRate of [4, 12, 20]) {
      const r = runModel({ ...base, vacancyRate });
      expect(r.months[0].phase).toBe('construction');
      expect(r.months[0].opex).toBeCloseTo(expected, 6);
    }
  });

  it('anchors an unrecognised property type to the firm-wide vacancy, not the deal\'s', () => {
    // A property type with no house default must not crash and must not fall
    // back to `vacancyRate`, which is the deal's own number and would reinstate
    // the bug on exactly the deals that escape the type table.
    const base = {
      propertyType: 'data-center-cold-storage-hybrid',
      constructionType: 'groundUp', location: 'Lubbock, TX',
      purchasePrice: 2_000_000, constructionCost: 15_000_000, buildingSize: 60_000,
      grossRevenue: 2_400_000, operatingExpenseRatio: 28,
      downPayment: 30, interestRate: 6.5, loanTerm: 25, exitCapRate: 7.5, holdPeriod: 5,
      assumptions: { rentGrowth: 0, expenseGrowth: 0, leaseUpMonths: 0 },
    };
    expect(propertyTypes[base.propertyType]).toBeUndefined();
    expect(firmDefault('vacancyRate', base.propertyType)).toBe(FIRM_DEFAULTS.global.vacancyRate);

    const monthlyAtFull = (2_400_000 / 12) * 0.28;
    const firmOcc = 1 - FIRM_DEFAULTS.global.vacancyRate / 100;
    const intercepts = [4, 18].map((vacancyRate) => {
      const r = runModel({ ...base, vacancyRate });
      expect(r.incomplete).toBeUndefined();
      expect(Number.isFinite(r.operating.stabilizedNOI)).toBe(true);
      const m = r.months[r.operating.stabilizationMonth];
      return m.opex - VARIABLE_SHARE * monthlyAtFull * m.occ;
    });
    expect(intercepts[0]).toBeCloseTo(FIXED_SHARE * monthlyAtFull * firmOcc, 9);
    expect(intercepts[0]).toBeCloseTo(intercepts[1], 9);
  });
});

// ─── 2. the ground-up land carry ─────────────────────────────────────────────

describe('ground-up land carry', () => {
  const groundUp = {
    propertyType: 'industrial', constructionType: 'groundUp', location: 'Houston, TX',
    purchasePrice: 8_000_000, constructionCost: 61_000_000, buildingSize: 642_000,
    grossRevenue: 7_223_000, vacancyRate: 5, operatingExpenseRatio: 25,
    downPayment: 35, interestRate: 6.6, loanTerm: 25, exitCapRate: 6.9, holdPeriod: 7,
  };

  it('charges land tax on the acquisition basis at the jurisdiction rate for the build duration', () => {
    const r = runModel(groundUp);
    // 18-month default build, $8m of land, Harris County at 2.81%.
    expect(r.timeline.constructionMonths).toBe(18);
    expect(r.budget.landCarry).toBeCloseTo(8_000_000 * 0.0281 * 1.5, 6);
    expect(r.budget.landCarry).toBeCloseTo(337_200, 6);
  });

  it('shows it as its own line in sources and uses', () => {
    const r = runModel(groundUp);
    const line = r.budget.lines.find((l) => l.key === 'landCarry');
    expect(line).toBeDefined();
    expect(line.amount).toBeCloseTo(r.budget.landCarry, 6);
    // ...and the schedule still foots to total development cost with it there.
    const sum = r.budget.lines.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBeCloseTo(r.budget.totalProjectCost, 4);
  });

  it('separates two jurisdictions that used to carry the identical implied load', () => {
    // The defence for charging nothing was a flat 14% soft cost load. A flat
    // percentage of HARD cost is not a rate on LAND over a DURATION: a Texas
    // ground-up and a Florida ground-up carried the same implied carry, and
    // their yields on cost are compared side by side on the Pipeline screen.
    const houston = runModel(groundUp);                                    // 2.81%
    const miami = runModel({ ...groundUp, location: 'Miami, FL' });        // 1.02%
    expect(houston.budget.landCarry / miami.budget.landCarry)
      .toBeCloseTo(2.81 / 1.02, 9);
    expect(houston.budget.landCarry - miami.budget.landCarry)
      .toBeCloseTo(8_000_000 * (0.0281 - 0.0102) * 1.5, 6);
  });

  it('scales with the build duration, not with the size of the building', () => {
    const twelve = runModel({ ...groundUp, constructionMonths: 12 });
    const twentyFour = runModel({ ...groundUp, constructionMonths: 24 });
    expect(twentyFour.budget.landCarry).toBeCloseTo(twelve.budget.landCarry * 2, 6);
    // Not a function of hard cost, which is what the soft-cost load made it.
    expect(runModel({ ...groundUp, constructionCost: 122_000_000 }).budget.landCarry)
      .toBeCloseTo(runModel(groundUp).budget.landCarry, 6);
  });

  it('is not circular: it does not move with anything the interest reserve depends on', () => {
    // The tax is struck on the ACQUISITION basis, which is known at closing, so
    // it can be charged before total project cost exists. Striking it on total
    // cost would be circular — the reserve this line feeds is part of that
    // total. This is the check, not the assumption.
    const base = runModel(groundUp).budget.landCarry;
    for (const patch of [
      { interestRate: 12 },
      { downPayment: 5 },
      { contingencyRate: 0.30 },
      { softCostPct: 0.25 },
      { financingCosts: 2_000_000 },
      { exitCapRate: 9 },
    ]) {
      expect(runModel({ ...groundUp, ...patch }).budget.landCarry).toBeCloseTo(base, 6);
    }
  });

  it('accrues into the interest reserve rather than being bolted on after total cost', () => {
    // Drawn month by month with the rest of the budget, so the loan funds its
    // share and that share bears interest — which is what "accrues into the
    // reserve" means. Two proofs: the monthly draws foot to base cost including
    // the carry, and a deal with a carry capitalises more interest than the
    // same deal in a jurisdiction that charges none.
    const r = runModel(groundUp);
    const drawn = r.months.reduce((s, m) => s + (m.cost || 0), 0);
    expect(drawn).toBeCloseTo(r.budget.baseProjectCost, 4);
    expect(r.budget.baseProjectCost).toBeGreaterThan(
      r.budget.land + r.budget.hardCost + r.budget.softCost + r.budget.contingency,
    );

    const untaxed = runModel({ ...groundUp, propertyTaxRate: 0 });
    expect(untaxed.budget.landCarry).toBe(0);
    expect(r.budget.capitalizedInterest).toBeGreaterThan(untaxed.budget.capitalizedInterest);
    expect(r.budget.totalProjectCost)
      .toBeCloseTo(r.budget.baseProjectCost + r.budget.capitalizedInterest, 6);
  });

  it('charges no separate carry on a repositioning deal, which pays it through the P&L', () => {
    // Charging it here as well would double it: the renovation months already
    // run an operating statement, and `inPlaceTax` is the same bill on the same
    // basis. The gate is `hasInPlaceIncome`, which is the same gate that
    // decides whether a renovation P&L exists at all.
    for (const constructionType of ['acquisition', 'ti']) {
      const r = runModel({ ...groundUp, constructionType, assumptions: { inPlaceRevenue: 3_000_000 } });
      expect(constructionTypes[constructionType].hasInPlaceIncome).toBe(true);
      expect(r.budget.landCarry).toBe(0);
      expect(r.budget.lines.some((l) => l.key === 'landCarry')).toBe(false);
      // The tax is charged, just through the statement instead.
      expect(r.months[0].tax).toBeCloseTo(8_000_000 * 0.0281 / 12, 6);
    }
  });

  it('relieves the ground-up soft cost load of exactly the carry it was standing in for', () => {
    // The relief is DERIVED from the five ground-up samples, not chosen. This
    // recomputes it from the same inputs propertyTypes.js documents: were the
    // two to drift, the carry would be charged once and a half, or once and a
    // third, and nothing else in the suite would notice.
    const shares = SAMPLE_DEALS
      .filter((d) => !constructionTypes[d.constructionType].hasInPlaceIncome)
      .map((d) => {
        const months = d.constructionMonths ?? constructionTypes[d.constructionType].timeframe;
        const rate = d.propertyTaxRate ?? getPropertyTaxRate(d.location);
        return (d.purchasePrice * (rate / 100) * (months / 12)) / d.constructionCost;
      });
    expect(shares).toHaveLength(5);
    const mean = shares.reduce((s, x) => s + x, 0) / shares.length;
    expect(mean).toBeCloseTo(0.010102, 6);
    expect(constructionTypes.groundUp.softCostPct).toBeCloseTo(0.14 - mean, 4);
    expect(constructionTypes.groundUp.softCostPct).toBe(0.1299);
    // The floor a soft cost load cannot honestly go below — design, permitting
    // and impact fees, legal and title, the developer fee. The derived relief
    // did not reach it, so no arithmetic was forced and no floor was invoked.
    expect(constructionTypes.groundUp.softCostPct).toBeGreaterThan(0.10);
  });
});

// ─── 3. multiple IRR roots ───────────────────────────────────────────────────

describe('countSignChanges', () => {
  it('counts alternations in the nonzero terms', () => {
    expect(countSignChanges([-100, 50, 50, 50])).toBe(1);
    expect(countSignChanges([100, 50])).toBe(0);
    expect(countSignChanges([-100, 300, -250])).toBe(2);
    expect(countSignChanges([-1, 1, -1, 1])).toBe(3);
  });

  it('does not count an idle period as a change of direction', () => {
    // A month with no flow is not a turn. Counting zeros would report multiple
    // roots on every schedule with a quiet month, which is most of them.
    expect(countSignChanges([-100, 0, 0, 50, 0, 60])).toBe(1);
    expect(countSignChanges([0, 0, -100, 110])).toBe(1);
  });

  it('reports an unreadable series as unknown, not as zero', () => {
    // Zero sign changes is a meaningful answer — no IRR exists at all — so it
    // must not double as "could not tell".
    expect(countSignChanges([-100, NaN, 50])).toBeNull();
    expect(countSignChanges(null)).toBeNull();
    expect(countSignChanges([-100, Infinity])).toBeNull();
  });
});

describe('irrWithDiagnostics', () => {
  it('leaves irr() returning number-or-null, which callers depend on', () => {
    expect(typeof irr([-100, 110])).toBe('number');
    expect(irr([-100, -110])).toBeNull();
    expect(irr([1])).toBeNull();
  });

  it('calls a conventional series unique', () => {
    const d = irrWithDiagnostics([-1000, 300, 300, 300, 300]);
    expect(d.signChanges).toBe(1);
    expect(d.unique).toBe(true);
    expect(d.rate).toBeCloseTo(irr([-1000, 300, 300, 300, 300]), 12);
  });

  it('refuses to call a multi-root series unique, and there really are two roots', () => {
    // The classic pump: spend, earn, then spend again to close out. Two rates
    // zero this NPV, and bisection returns whichever its bracket caught. Both
    // roots are demonstrated here rather than asserted — a claim that "several
    // exist" is worth nothing without them.
    const flows = [-100, 350, -200];
    const d = irrWithDiagnostics(flows);
    expect(d.signChanges).toBe(2);
    expect(d.unique).toBe(false);

    // NPV is the quadratic 200x^2 - 350x + 100 in x = 1/(1+r), and both its
    // roots are positive, so both map to a rate above -100%.
    const disc = Math.sqrt(350 * 350 - 4 * 200 * 100);
    const roots = [(350 + disc) / 400, (350 - disc) / 400].map((x) => 1 / x - 1);
    expect(roots[0]).toBeCloseTo(-0.280777, 5);
    expect(roots[1]).toBeCloseTo(1.780775, 5);
    for (const r of roots) expect(npv(r, flows)).toBeCloseTo(0, 9);
    // The solver returned one of them — the one its bracket happened to catch,
    // which is the whole point: nothing about the deal chose it.
    expect(roots.some((r) => Math.abs(d.rate - r) < 1e-6)).toBe(true);
    expect(d.rate).toBeCloseTo(roots[0], 9);
  });

  it('reports non-uniqueness even where the solver finds no root at all', () => {
    // Both roots of this one sit inside a positive hump the bracket steps over,
    // so irr() correctly declines to answer. The diagnostic is independent of
    // the solve: the series is still multi-rooted, and a caller must not read
    // the null as "conventional series, no return".
    const flows = [-100, 260, -165];
    const d = irrWithDiagnostics(flows);
    expect(d.rate).toBeNull();
    expect(d.signChanges).toBe(2);
    expect(d.unique).toBe(false);
    expect(npv(0.10, flows)).toBeCloseTo(0, 9);
    expect(npv(0.50, flows)).toBeCloseTo(0, 9);
  });

  it('reports uniqueness as unknown when the series cannot be read', () => {
    const d = irrWithDiagnostics([-100, NaN, 50]);
    expect(d.rate).toBeNull();
    expect(d.signChanges).toBeNull();
    expect(d.unique).toBeNull();
  });
});

describe('the model carries the IRR uniqueness verdict', () => {
  it('threads a diagnostic for each series onto returns.irrDiagnostics', () => {
    const r = runModel(SAMPLE_DEALS[0]);
    for (const key of ['levered', 'unlevered']) {
      expect(r.returns.irrDiagnostics[key]).toEqual({
        signChanges: expect.any(Number),
        unique: expect.any(Boolean),
      });
    }
  });

  it('names exactly the sample deals whose levered IRR is not unique', () => {
    // Computed, not assumed. Three of the nine trip it, and all three are
    // repositioning deals: in-place income distributes cash during the
    // renovation months, then the first operating months run negative while the
    // asset leases up, then the hold turns positive again. Three sign changes,
    // so several rates zero the NPV and the one reported is the one the bracket
    // caught. A surface must label those three; the other six may print the
    // figure bare.
    const notUnique = SAMPLE_DEALS
      .filter((d) => runModel(d).returns.irrDiagnostics.levered.unique === false)
      .map((d) => d.name);
    expect(notUnique.sort()).toEqual([
      'Alamo Ridge Apartments',
      'Plano North Campus',
      'Tampa Retail Repositioning',
    ]);
    for (const deal of SAMPLE_DEALS) {
      const dg = runModel(deal).returns.irrDiagnostics;
      // The unlevered series is one sign change on every sample: the property
      // spends, then earns, and never calls capital back.
      expect(dg.unlevered.unique).toBe(true);
      expect(dg.levered.signChanges).toBeGreaterThanOrEqual(1);
    }
  });

  it('reports uniqueness as unknown on a model that was never scheduled', () => {
    const r = runModel({ purchasePrice: 1_000_000, holdPeriod: 0 });
    expect(r.incomplete).toBe(true);
    expect(r.returns.irrDiagnostics.levered).toEqual({ signChanges: null, unique: null });
    expect(r.returns.irrDiagnostics.unlevered).toEqual({ signChanges: null, unique: null });
  });
});

// ─── 4. the equity commitment basis ──────────────────────────────────────────

describe('equity is struck on the basis the LTC covenant tests', () => {
  it.each(SAMPLE_DEALS.map((d) => [d.name, d]))(
    '%s funds exactly its stated leverage', (_name, deal) => {
      const r = runModel(deal);
      expect(r.financing.equityCommitment)
        .toBeCloseTo(r.budget.totalProjectCost * (deal.downPayment / 100), 6);
      expect(r.financing.ltc).toBeCloseTo(1 - deal.downPayment / 100, 12);
      // The commitments still fund the base budget between them; only the split
      // moved. The reserve is borrowed on top, which is what a reserve is.
      expect(r.financing.equityCommitment + r.financing.loanCommitment)
        .toBeCloseTo(r.budget.baseProjectCost, 6);
      expect(r.financing.permanentLoanBalance)
        .toBeCloseTo(r.financing.loanCommitment + r.budget.capitalizedInterest, 6);
    },
  );

  it('names the bug: a base-struck cheque breaches the covenant by the reserve', () => {
    // Houston Express Tunnel reported 70.89% LTC on a 30% equity cheque and
    // Dallas Office TI 70.89%, against a 70% maximum. Neither was over-levered.
    // An equity commitment struck on base cost leaves the residual loan at 70%
    // of base PLUS the whole interest reserve, over a total that is base plus
    // the same reserve — above 70% by construction on every deal with a
    // meaningful reserve. This reconstructs the old figure and shows the new
    // one clearing.
    for (const name of ['Houston Express Tunnel', 'Dallas Office TI']) {
      const deal = SAMPLE_DEALS.find((d) => d.name === name);
      const r = runModel(deal);
      const reserve = r.budget.capitalizedInterest;
      expect(reserve).toBeGreaterThan(0);
      const baseStruckLTC =
        (r.budget.baseProjectCost * (1 - deal.downPayment / 100) + reserve)
        / r.budget.totalProjectCost;
      expect(baseStruckLTC).toBeGreaterThan(DEFAULT_COVENANTS.maxLTC);
      expect(baseStruckLTC).toBeGreaterThan(0.708);
      expect(r.financing.ltc).toBeCloseTo(0.70, 12);
    }
  });

  it('raises no leverage flag on any of the nine samples', () => {
    // Two unexplained covenant breaches in a nine-deal showcase read as a
    // broken model, not a cautious one. Austin is thin on purpose and is
    // documented as such; these two were a modelling error.
    for (const deal of SAMPLE_DEALS) {
      const ids = validate(runModel(deal), deal).map((f) => f.id);
      expect(ids).not.toContain('ltc');
    }
  });

  it('holds for a deal with no construction period, where the reserve is zero', () => {
    const standing = {
      propertyType: 'retail', constructionType: 'acquisition', location: 'Tampa, FL',
      purchasePrice: 9_000_000, constructionCost: 0, buildingSize: 30_000,
      grossRevenue: 900_000, vacancyRate: 7, operatingExpenseRatio: 20,
      downPayment: 30, interestRate: 6.1, loanTerm: 25, exitCapRate: 7, holdPeriod: 5,
      constructionMonths: 0,
    };
    const r = runModel(standing);
    expect(r.budget.capitalizedInterest).toBe(0);
    // With no reserve the two bases coincide, so the fix must be a no-op here.
    expect(r.financing.equityCommitment).toBeCloseTo(r.budget.baseProjectCost * 0.30, 6);
    expect(r.financing.ltc).toBeCloseTo(0.70, 12);
  });

  it('converges rather than truncating: the fixed point is exact to the cent', () => {
    // Capitalised interest depends on the split and the split depends on
    // capitalised interest, so this is solved, not computed. A truncated loop
    // would leave the LTC a few basis points off the stated leverage — which is
    // the same class of error the fix exists to remove.
    const heavy = {
      propertyType: 'multifamily', constructionType: 'groundUp', location: 'Austin, TX',
      purchasePrice: 5_000_000, constructionCost: 40_000_000, buildingSize: 200_000, units: 220,
      grossRevenue: 5_500_000, vacancyRate: 5, operatingExpenseRatio: 32,
      downPayment: 25, interestRate: 11, loanTerm: 30, exitCapRate: 5.8, holdPeriod: 7,
      constructionMonths: 30,
    };
    const r = runModel(heavy);
    expect(r.budget.capitalizedInterest).toBeGreaterThan(r.budget.baseProjectCost * 0.08);
    expect(r.financing.ltc).toBeCloseTo(0.75, 12);
    expect(Math.abs(r.financing.ltc - 0.75) * r.budget.totalProjectCost).toBeLessThan(0.01);
  });
});

// ─── the GP co-invest share comes from the firm's assumption set ─────────────

describe('GP co-invest share', () => {
  it('splits the equity cheque on the house standard', () => {
    const r = runModel(SAMPLE_DEALS[0]);
    expect(r.financing.gpCoInvest)
      .toBeCloseTo(r.financing.equityCommitment * FIRM_DEFAULTS.global.gpCoInvestShare, 6);
    expect(r.financing.gpCoInvest + r.financing.lpEquity)
      .toBeCloseTo(r.financing.equityCommitment, 6);
  });

  it('moves when the house standard moves', () => {
    // The point of the governance layer: changing FIRM_DEFAULTS must change the
    // model. Written as a literal 0.20 in finance.js, raising the house standard
    // changed the governance layer and left the model splitting the cheque the
    // old way — a divergence with no symptom until an LP asked why.
    const original = FIRM_DEFAULTS.global.gpCoInvestShare;
    try {
      FIRM_DEFAULTS.global.gpCoInvestShare = 0.35;
      const r = runModel(SAMPLE_DEALS[0]);
      expect(r.financing.gpCoInvest).toBeCloseTo(r.financing.equityCommitment * 0.35, 6);
      expect(r.financing.lpEquity).toBeCloseTo(r.financing.equityCommitment * 0.65, 6);
    } finally {
      FIRM_DEFAULTS.global.gpCoInvestShare = original;
    }
    expect(runModel(SAMPLE_DEALS[0]).financing.gpCoInvest)
      .toBeCloseTo(runModel(SAMPLE_DEALS[0]).financing.equityCommitment * original, 6);
  });

  it('still lets a deal override it', () => {
    const r = runModel({ ...SAMPLE_DEALS[0], gpCoInvestShare: 0.05 });
    expect(r.financing.gpCoInvest).toBeCloseTo(r.financing.equityCommitment * 0.05, 6);
  });

  it('reports an unsplittable cheque as unknown rather than as an 80/20', () => {
    // With no house standard there is no split. A confident 80/20 here would be
    // the engine inventing a term sheet.
    const original = FIRM_DEFAULTS.global.gpCoInvestShare;
    try {
      delete FIRM_DEFAULTS.global.gpCoInvestShare;
      const r = runModel(SAMPLE_DEALS[0]);
      expect(r.financing.equityCommitment).toBeGreaterThan(0);
      expect(r.financing.gpCoInvest).toBeNull();
      expect(r.financing.lpEquity).toBeNull();
    } finally {
      FIRM_DEFAULTS.global.gpCoInvestShare = original;
    }
  });
});
