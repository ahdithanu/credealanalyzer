/**
 * Firm-level assumption defaults.
 *
 * This is the governance layer, and the reason an enterprise buys a tool like
 * this rather than letting each analyst keep a spreadsheet: every deal starts
 * from the same house standards, and any departure is visible and attributable.
 *
 * In the shipped product these live server-side, versioned per property type
 * and market, with an approval trail. Here they are a static baseline — the
 * shape is right, the persistence is not.
 */

export const FIRM_DEFAULTS = {
  global: {
    interestRate: 6.40,
    loanTerm: 25,
    downPayment: 30,
    vacancyRate: 5,
    costOfSalePct: 0.015,
    rentGrowth: 0.03,
    expenseGrowth: 0.025,
    assessmentGrowth: 0.025,
    gpCoInvestShare: 0.20,
  },
  byPropertyType: {
    carwash:     { operatingExpenseRatio: 44, exitCapRate: 7.25, vacancyRate: 3 },
    multifamily: { operatingExpenseRatio: 32, exitCapRate: 5.60 },
    office:      { operatingExpenseRatio: 30, exitCapRate: 8.00, vacancyRate: 10 },
    retail:      { operatingExpenseRatio: 21, exitCapRate: 7.25, vacancyRate: 7 },
    industrial:  { operatingExpenseRatio: 25, exitCapRate: 6.75 },
  },
  version: 'Q2 2026 · v4',
};

/** The effective default for a field on a given deal. */
export function firmDefault(field, propertyType) {
  const byType = FIRM_DEFAULTS.byPropertyType[propertyType] || {};
  if (field in byType) return byType[field];
  if (field in FIRM_DEFAULTS.global) return FIRM_DEFAULTS.global[field];
  return undefined;
}

/** Fields where the deal departs from the firm default, with both values. */
export function overrides(deal) {
  const out = [];
  const fields = new Set([
    ...Object.keys(FIRM_DEFAULTS.global),
    ...Object.keys(FIRM_DEFAULTS.byPropertyType[deal.propertyType] || {}),
  ]);
  for (const field of fields) {
    const def = firmDefault(field, deal.propertyType);
    const val = deal[field] ?? deal.assumptions?.[field];
    if (val === undefined || def === undefined) continue;
    if (Math.abs(val - def) > 1e-9) out.push({ field, value: val, firmValue: def });
  }
  return out;
}
