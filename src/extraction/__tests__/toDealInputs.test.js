// Lives with the extraction tests, not src/lib/__tests__, so that
// scripts/mutation-check.py (which runs `vitest run src/extraction`) can catch
// a broken guard in toDealInputs.
import { describe, it, expect } from 'vitest';
import { toDealInputs, NO_DEAL_INPUT, DEAL_PROPERTY_TYPES, houseOccupancy } from '../../lib/ingest/toDealInputs';
import { PRODUCT_FIELD_NAMES } from '../schema';
import { runModel } from '../../lib/finance';

// FIXTURE review states (contract C4). Hand-written; no real document.
const ok = (value) => ({ status: 'confirmed', value });
const edited = (value) => ({ status: 'edited', value, note: 'fixture edit' });

describe('only applied values reach the patch', () => {
  it('ignores pending and rejected values, and reports them', () => {
    const r = toDealInputs({
      squareFeet: { status: 'pending', value: 72_000 },
      units: { status: 'rejected', value: 80 },
      interestRate: ok(6.25),
      askingPrice: { status: 'mystery', value: 1_000_000 },
    });
    expect(r.patch).toEqual({ interestRate: 6.25 });
    expect(r.notApplied).toEqual([
      { field: 'squareFeet', status: 'pending' },
      { field: 'units', status: 'rejected' },
      { field: 'askingPrice', status: 'mystery' },
    ]);
  });

  it('uses an edited value as the human wrote it', () => {
    expect(toDealInputs({ units: edited(82) }).patch).toEqual({ units: 82 });
  });

  it('never uses a pending value as an operand of a conversion', () => {
    const r = toDealInputs({
      operatingExpenses: ok(900_000),
      operatingExpensesIncludeTaxes: ok('includes-taxes'),
      realEstateTaxes: { status: 'pending', value: 200_000 },
      grossPotentialRent: ok(2_000_000), propertyType: ok('multifamily'),
    });
    expect(r.patch.operatingExpenseRatio).toBeUndefined();
    expect(r.incomplete).toEqual([{ input: 'operatingExpenseRatio', reason: expect.stringMatching(/realEstateTaxes/) }]);
    expect(r.patch.grossRevenue).toBe(2_000_000);
  });

  it('writes nothing, and no zero, for an empty review or null values', () => {
    expect(toDealInputs({}).patch).toEqual({});
    expect(toDealInputs().patch).toEqual({});
    const r = toDealInputs({ units: ok(null), squareFeet: edited(undefined), askingPrice: ok(0), loanTermYears: ok(-1) });
    expect(r.patch).toEqual({});
    expect(r.invalid.map((x) => x.field)).toEqual(['askingPrice', 'loanTermYears']);
    // An applied entry with no value is reported, not silently skipped.
    expect(r.noValue).toEqual([
      { field: 'squareFeet', status: 'edited' },
      { field: 'units', status: 'confirmed' },
    ]);
  });

  it('never coerces a string into a number', () => {
    const r = toDealInputs({ squareFeet: edited('72,000'), units: ok(80.5) });
    expect(r.patch).toEqual({});
    expect(r.invalid).toEqual([
      { field: 'squareFeet', reason: 'not a valid area value' },
      { field: 'units', reason: 'not a valid count value' },
    ]);
  });

  it('refuses a rate written as a fraction', () => {
    const r = toDealInputs({ interestRate: ok(0.0525), capRate: ok(0.06) });
    expect(r.patch).toEqual({});
    expect(r.invalid.map((x) => x.field)).toEqual(['capRate', 'interestRate']);
  });

  it('refuses a rate or cap rate of exactly zero', () => {
    const r = toDealInputs({ interestRate: ok(0), capRate: edited(0) });
    expect(r.patch).toEqual({});
    expect(r.invalid).toEqual([
      { field: 'capRate', reason: 'must be greater than zero' },
      { field: 'interestRate', reason: 'must be greater than zero' },
    ]);
  });

  it('refuses a rate or percent above 100', () => {
    const r = toDealInputs({ interestRate: ok(150), capRate: ok(120), occupancy: ok(-3) });
    expect(r.patch).toEqual({});
    expect(r.invalid).toEqual([
      { field: 'capRate', reason: 'percent outside 0 to 100' },
      { field: 'occupancy', reason: 'percent outside 0 to 100' },
      { field: 'interestRate', reason: 'rate outside 0 to 100' },
    ]);
  });
});

describe('mappings and conversions', () => {
  it('maps identities to the engine\'s input names and units', () => {
    const r = toDealInputs({
      squareFeet: ok(72_000), units: ok(80), grossPotentialRent: ok(2_016_000),
      interestRate: ok(6.4), amortizationYears: ok(30), capRate: ok(5.6), askingPrice: ok(12_000_000),
      propertyType: ok('multifamily'),
    });
    expect(r.patch).toEqual({
      purchasePrice: 12_000_000, buildingSize: 72_000, units: 80, grossRevenue: 2_016_000,
      interestRate: 6.4, loanTerm: 30, entryCapRate: 5.6, propertyType: 'multifamily',
    });
    expect(r.provenance.loanTerm.fields).toEqual(['amortizationYears']);
  });

  it('takes taxes out of an expense total that includes them before dividing', () => {
    const r = toDealInputs({
      operatingExpenses: ok(900_000), operatingExpensesIncludeTaxes: ok('includes-taxes'),
      realEstateTaxes: ok(260_000), grossPotentialRent: ok(2_000_000), propertyType: ok('multifamily'),
    });
    // 640,000 ex-tax over GPR at the 95% house occupancy for multifamily.
    expect(r.patch.operatingExpenseRatio).toBeCloseTo((100 * 640_000) / (2_000_000 * 0.95), 10);
    expect(r.provenance.operatingExpenseRatio.fields)
      .toEqual(['operatingExpenses', 'realEstateTaxes', 'operatingExpensesIncludeTaxes', 'grossPotentialRent']);
  });

  it('divides an expense total stated without taxes by GPR at house occupancy', () => {
    const r = toDealInputs({
      operatingExpenses: ok(640_000), operatingExpensesIncludeTaxes: ok('excludes-taxes'),
      realEstateTaxes: ok(260_000), grossPotentialRent: ok(2_000_000), propertyType: ok('office'),
    });
    // Office house vacancy is 10%.
    expect(houseOccupancy('office')).toBeCloseTo(0.9, 12);
    expect(r.patch.operatingExpenseRatio).toBeCloseTo((100 * 640_000) / (2_000_000 * 0.9), 10);
  });

  it('strikes the ratio on the deal\'s own type when the review applies none', () => {
    const review = {
      operatingExpenses: ok(640_000), operatingExpensesIncludeTaxes: ok('excludes-taxes'),
      grossPotentialRent: ok(2_000_000),
    };
    const none = toDealInputs(review);
    expect(none.patch.operatingExpenseRatio).toBeUndefined();
    expect(none.incomplete).toEqual([{ input: 'operatingExpenseRatio', reason: expect.stringMatching(/propertyType/) }]);
    const r = toDealInputs(review, { propertyType: 'office' });
    expect(r.patch.operatingExpenseRatio).toBeCloseTo((100 * 640_000) / (2_000_000 * 0.9), 10);
    // A type the patch sets wins over the deal's.
    const p = toDealInputs({ ...review, propertyType: ok('multifamily') }, { propertyType: 'office' });
    expect(p.patch.operatingExpenseRatio).toBeCloseTo((100 * 640_000) / (2_000_000 * 0.95), 10);
  });

  for (const type of ['multifamily', 'office', 'retail', 'industrial']) {
    it(`carries a confirmed expense total into the engine intact (${type})`, () => {
      const { patch } = toDealInputs({
        propertyType: ok(type), askingPrice: ok(9_000_000), grossPotentialRent: ok(1_400_000),
        interestRate: ok(6.4), amortizationYears: ok(30),
        operatingExpenses: ok(450_000), operatingExpensesIncludeTaxes: ok('excludes-taxes'),
      });
      // Vacancy left at the house rate (no vacancyRate in the deal), no growth,
      // no lease-up: the engine's stabilized opex must be the stated 450,000.
      const model = runModel({
        constructionType: 'acquisition', location: 'San Antonio, TX', downPayment: 35,
        exitCapRate: 6, holdPeriod: 5, ...patch,
      }, { expenseGrowth: 0, rentGrowth: 0, leaseUpMonths: 0 });
      const stabilized = model.months.filter((m) => m.phase === 'stabilized').slice(0, 12);
      expect(stabilized).toHaveLength(12);
      expect(stabilized.reduce((s, m) => s + m.opex, 0)).toBeCloseTo(450_000, 4);
    });
  }

  it('does not guess whether expenses include taxes, and does not divide by nothing', () => {
    const a = toDealInputs({ operatingExpenses: ok(900_000), grossPotentialRent: ok(2_000_000), propertyType: ok('retail') });
    expect(a.patch.operatingExpenseRatio).toBeUndefined();
    expect(a.incomplete[0].reason).toMatch(/operatingExpensesIncludeTaxes/);
    const b = toDealInputs({ operatingExpenses: ok(900_000), operatingExpensesIncludeTaxes: ok('excludes-taxes') });
    expect(b.patch).toEqual({});
    expect(b.incomplete[0].reason).toMatch(/grossPotentialRent/);
    const c = toDealInputs({
      operatingExpenses: ok(100_000), operatingExpensesIncludeTaxes: ok('includes-taxes'),
      realEstateTaxes: ok(200_000), grossPotentialRent: ok(2_000_000), propertyType: ok('retail'),
    });
    expect(c.patch.operatingExpenseRatio).toBeUndefined();
    expect(c.incomplete[0].reason).toMatch(/exceeds/);
  });

  it('prefers a contract price over an asking price and reports the ask', () => {
    const r = toDealInputs({ purchasePrice: ok(11_500_000), askingPrice: ok(12_000_000) });
    expect(r.patch.purchasePrice).toBe(11_500_000);
    expect(r.superseded).toEqual([{ field: 'askingPrice', by: 'purchasePrice', reason: expect.stringMatching(/supersedes/) }]);
    expect(r.assumptions).toEqual([]);
  });

  it('says when the asking price is the same figure as the purchase price', () => {
    const r = toDealInputs({ purchasePrice: ok(12_000_000), askingPrice: edited(12_000_000) });
    expect(r.patch.purchasePrice).toBe(12_000_000);
    expect(r.superseded).toEqual([{ field: 'askingPrice', by: 'purchasePrice', reason: 'same figure as the purchase price' }]);
  });

  it('reports an asking price used as the purchase price as an underwriting choice', () => {
    const r = toDealInputs({ askingPrice: ok(12_000_000) });
    expect(r.patch.purchasePrice).toBe(12_000_000);
    expect(r.assumptions).toEqual([
      { input: 'purchasePrice', fields: ['askingPrice'], reason: expect.stringMatching(/underwriting choice/) },
    ]);
  });

  it('flags gross potential rent for base-rent types, where recoveries could double count', () => {
    const nnn = toDealInputs({ grossPotentialRent: ok(1_000_000), propertyType: ok('industrial') });
    expect(nnn.patch.grossRevenue).toBe(1_000_000);
    expect(nnn.assumptions).toEqual([
      { input: 'grossRevenue', fields: ['grossPotentialRent'], reason: expect.stringMatching(/base rent only/) },
    ]);
    const viaDeal = toDealInputs({ grossPotentialRent: ok(1_000_000) }, { propertyType: 'office' });
    expect(viaDeal.assumptions.map((x) => x.input)).toEqual(['grossRevenue']);
    const mf = toDealInputs({ grossPotentialRent: ok(1_000_000), propertyType: ok('multifamily') });
    expect(mf.assumptions).toEqual([]);
  });

  it('does not force a type the engine lacks', () => {
    const r = toDealInputs({ propertyType: ok('mixed-use') });
    expect(r.patch).toEqual({});
    expect(r.unmapped).toEqual([{ field: 'propertyType', reason: expect.stringMatching(/no "mixed-use" type/) }]);
    expect(DEAL_PROPERTY_TYPES).not.toContain('mixed-use');
  });

  it('lists fields with no deal input explicitly, and never patches them', () => {
    const review = {
      address: ok('100 Fixture Street'), yearBuilt: ok(1999), netOperatingIncome: ok(1_000_000),
      occupancy: ok(93), realEstateTaxes: ok(200_000), loanAmount: ok(8_000_000),
      loanTermYears: ok(10), weightedAverageLeaseTerm: ok(5.5),
    };
    const r = toDealInputs(review);
    expect(r.patch).toEqual({});
    expect(r.unmapped.map((x) => x.field).sort()).toEqual(Object.keys(review).sort());
    for (const name of Object.keys(NO_DEAL_INPUT)) expect(PRODUCT_FIELD_NAMES).toContain(name);
  });

  it('accounts for every product field: mapped, or listed as having no input', () => {
    const mapped = ['purchasePrice', 'askingPrice', 'squareFeet', 'units', 'grossPotentialRent', 'interestRate',
      'amortizationYears', 'capRate', 'propertyType', 'operatingExpenses'];
    expect([...mapped, ...Object.keys(NO_DEAL_INPUT)].sort()).toEqual([...PRODUCT_FIELD_NAMES].sort());
  });

  it('produces a patch the deal model runs on', () => {
    const { patch } = toDealInputs({
      propertyType: ok('multifamily'), askingPrice: ok(9_000_000), squareFeet: ok(72_000), units: ok(80),
      grossPotentialRent: ok(1_400_000), interestRate: ok(6.4), amortizationYears: ok(30),
      operatingExpenses: ok(450_000), operatingExpensesIncludeTaxes: ok('excludes-taxes'),
    });
    const model = runModel({
      constructionType: 'acquisition', location: 'San Antonio, TX', downPayment: 35, exitCapRate: 6, holdPeriod: 5, ...patch,
    });
    expect(model.incomplete).toBeFalsy();
    expect(model.assumptions).toBeDefined();
  });
});
