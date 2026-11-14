/**
 * Reviewed extraction values to a patch of deal-model inputs.
 *
 * The input is one document's review state (contract C4):
 *   { [fieldName]: { status: 'pending'|'confirmed'|'rejected'|'edited', value, note? } }
 *
 * Only 'confirmed' and 'edited' values are APPLIED, and only applied values are
 * read. A pending value is a model's answer nobody has looked at; a rejected one
 * is an answer somebody looked at and said no to. Neither may reach a deal
 * input, by any route, including as one operand of a conversion.
 *
 * The output is a PATCH, not a deal: it says which inputs these values would
 * set, and the caller applies it only on a human action. Nothing here writes a
 * default, and nothing writes 0 for an unknown. An input whose source value is
 * missing is absent from the patch, which leaves the deal's own value (or the
 * firm default) in force, and the reason is reported.
 *
 * Inputs are the ones src/lib/finance.js runModel reads, in its units:
 *   purchasePrice  USD           buildingSize  sq ft        units  count
 *   grossRevenue   USD/yr (gross potential, before vacancy)
 *   operatingExpenseRatio  % of grossRevenue, EXCLUDING property tax, which
 *                          the engine computes separately from a market rate
 *   interestRate   % points      loanTerm  years (the AMORTIZATION period:
 *                                runModel amortizes over it)
 *   entryCapRate   % points      propertyType  one of the engine's types
 */

import { PRODUCT_FIELDS, PRODUCT_COMPARATORS } from '../../extraction/schema.js';
import { validValue } from '../../extraction/productExtractor.js';

/** The engine's property types that an extracted type can name. */
export const DEAL_PROPERTY_TYPES = ['multifamily', 'office', 'retail', 'industrial'];

const APPLIED = new Set(['confirmed', 'edited']);

/**
 * Product fields with no deal input to map to, and why. Explicit, so a field
 * the deal model cannot take is reported as such and is never quietly dropped
 * or squeezed into an input that means something else.
 */
export const NO_DEAL_INPUT = {
  address: 'The deal\'s location is a market key ("City, ST") that selects the property tax rate; a street address is not one, and parsing a market out of it is a guess.',
  yearBuilt: 'The deal model has no vintage input.',
  netOperatingIncome: 'The deal model derives NOI from revenue, vacancy and expenses. A stated NOI is a check on those inputs, not an input.',
  occupancy: 'In-place occupancy is a fact about today. vacancyRate is the stabilized underwriting assumption the firm sets; copying one into the other is an underwriting decision, not a unit conversion.',
  realEstateTaxes: 'The engine taxes the assessed basis at the market\'s effective rate (propertyTaxRate); a dollar amount is not that rate. Used only to take taxes out of operating expenses.',
  operatingExpensesIncludeTaxes: 'Not an input. Says whether operatingExpenses must have taxes removed before it becomes operatingExpenseRatio.',
  loanAmount: 'The deal model sizes the loan as a share of TOTAL project cost (downPayment), which includes lines an offering memorandum does not state. Dividing by the price alone would set the wrong leverage.',
  loanTermYears: 'The deal model does not model maturity or refinancing. loanTerm is the amortization period, which is amortizationYears.',
  weightedAverageLeaseTerm: 'The deal model has no lease-level input.',
};

/**
 * @param {Object} review  contract C4 review state for one document
 * @returns {{
 *   patch: Object,
 *   provenance: Object<string, {fields: string[], conversion: string}>,
 *   unmapped: Array<{field: string, reason: string}>,
 *   notApplied: Array<{field: string, status: string}>,
 *   invalid: Array<{field: string, reason: string}>,
 *   incomplete: Array<{input: string, reason: string}>,
 *   superseded: Array<{field: string, by: string, reason: string}>,
 * }}
 */
export function toDealInputs(review = {}) {
  const out = {
    patch: {}, provenance: {}, unmapped: [], notApplied: [], invalid: [], incomplete: [], superseded: [],
  };

  // Applied, valid values only. Everything else is reported and then invisible
  // to every mapping below.
  const v = {};
  for (const f of PRODUCT_FIELDS) {
    const r = review[f.name];
    if (!r) continue;
    if (!APPLIED.has(r.status)) {
      out.notApplied.push({ field: f.name, status: r.status ?? 'unknown' });
      continue;
    }
    if (r.value === null || r.value === undefined) continue;
    const bad = invalidReason(f, r.value);
    if (bad) {
      out.invalid.push({ field: f.name, reason: bad });
      continue;
    }
    v[f.name] = r.value;
  }

  const set = (input, value, fields, conversion) => {
    out.patch[input] = value;
    out.provenance[input] = { fields, conversion };
  };
  const has = (name) => Object.prototype.hasOwnProperty.call(v, name);

  // Price. A price the property traded or is contracted at is the basis; an
  // asking price is what the seller hopes for. Both applied: the contract
  // price, with the ask reported, not averaged and not silently dropped.
  if (has('purchasePrice')) {
    set('purchasePrice', v.purchasePrice, ['purchasePrice'], 'identity (USD)');
    if (has('askingPrice')) {
      const same = PRODUCT_COMPARATORS.money(v.askingPrice, v.purchasePrice);
      out.superseded.push({
        field: 'askingPrice', by: 'purchasePrice',
        reason: same ? 'same figure as the purchase price' : 'a contract price supersedes an asking price',
      });
    }
  } else if (has('askingPrice')) {
    set('purchasePrice', v.askingPrice, ['askingPrice'], 'identity (USD): asking price used as the purchase price');
  }

  if (has('squareFeet')) set('buildingSize', v.squareFeet, ['squareFeet'], 'identity (sq ft)');
  if (has('units')) set('units', v.units, ['units'], 'identity (count)');
  if (has('grossPotentialRent')) {
    set('grossRevenue', v.grossPotentialRent, ['grossPotentialRent'], 'identity (USD/yr, before vacancy)');
  }
  if (has('interestRate')) set('interestRate', v.interestRate, ['interestRate'], 'identity (% points)');
  if (has('amortizationYears')) {
    set('loanTerm', v.amortizationYears, ['amortizationYears'], 'identity (years): runModel amortizes over loanTerm');
  }
  if (has('capRate')) set('entryCapRate', v.capRate, ['capRate'], 'identity (% points)');

  if (has('propertyType')) {
    if (DEAL_PROPERTY_TYPES.includes(v.propertyType)) {
      set('propertyType', v.propertyType, ['propertyType'], 'identity');
    } else {
      out.unmapped.push({
        field: 'propertyType',
        reason: `The deal model has no "${v.propertyType}" type. Choosing the nearest one is an underwriting decision.`,
      });
    }
  }

  operatingExpenseRatio(v, has, set, out);

  for (const name of Object.keys(NO_DEAL_INPUT)) {
    if (has(name)) out.unmapped.push({ field: name, reason: NO_DEAL_INPUT[name] });
  }
  return out;
}

/**
 * operatingExpenseRatio = operating expenses EXCLUDING property tax, as a
 * percentage of gross potential rent. The engine charges property tax on its
 * own, so an expense total that includes taxes would charge them twice; the
 * taxes come out first, and only when the document said the total holds them.
 */
function operatingExpenseRatio(v, has, set, out) {
  if (!has('operatingExpenses')) return;
  const why = (reason) => out.incomplete.push({ input: 'operatingExpenseRatio', reason });
  if (!has('grossPotentialRent')) return why('needs an applied grossPotentialRent to divide by');
  if (!(v.grossPotentialRent > 0)) return why('grossPotentialRent is not positive');
  if (!has('operatingExpensesIncludeTaxes')) {
    return why('needs operatingExpensesIncludeTaxes: without it, taxes may be charged twice');
  }
  let exTax = v.operatingExpenses;
  const fields = ['operatingExpenses', 'operatingExpensesIncludeTaxes', 'grossPotentialRent'];
  let conversion = '100 * operatingExpenses / grossPotentialRent (expenses stated without taxes)';
  if (v.operatingExpensesIncludeTaxes === 'includes-taxes') {
    if (!has('realEstateTaxes')) return why('expenses include taxes and no realEstateTaxes is applied to remove');
    exTax = v.operatingExpenses - v.realEstateTaxes;
    if (exTax < 0) return why('realEstateTaxes exceeds operatingExpenses');
    fields.splice(1, 0, 'realEstateTaxes');
    conversion = '100 * (operatingExpenses - realEstateTaxes) / grossPotentialRent';
  }
  set('operatingExpenseRatio', (100 * exTax) / v.grossPotentialRent, fields, conversion);
}

/** Why an applied value cannot be used, or null. Never coerces. */
function invalidReason(field, value) {
  if (!validValue(field, value)) return `not a valid ${field.kind} value`;
  const positive = ['money', 'area', 'count', 'duration'];
  if (positive.includes(field.kind) && !(value > 0)) return 'must be greater than zero';
  if (field.kind === 'percent' && (value < 0 || value > 100)) return 'percent outside 0 to 100';
  if (field.kind === 'rate' && (value < 0 || value > 100)) return 'rate outside 0 to 100';
  // The same rule labels.js applies: a rate in (0, 1) is a fraction written
  // where percentage points belong (0.0525 for 5.25%).
  if ((field.kind === 'rate' || field.name === 'capRate') && value > 0 && value < 1) {
    return 'looks like a fraction; rates are percentage points (5.25 for 5.25%)';
  }
  return null;
}
