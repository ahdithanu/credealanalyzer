/**
 * Domain configuration for property and construction types.
 *
 * Deliberately free of React/icon imports so the finance engine and its tests
 * can consume this without pulling in the UI layer.
 */

export const propertyTypes = {
  carwash: {
    name: 'Car Wash',
    color: '#8b5cf6',
    // Revenue basis differs by type; `revenueBasis` tells the UI how to
    // interpret `avgRevenue` when suggesting a placeholder.
    revenueBasis: 'site',      // annual revenue per site
    avgRevenue: 580000,
    // `avgRevenue`, `avgOpEx` and `avgCapRate` are INPUT-FORM PLACEHOLDERS, not
    // house assumptions. The firm's assumption set in firmDefaults.js is the
    // governance layer and is what finance.js and screen.js resolve against;
    // these numbers disagree with it by up to 17 points and a caller reaching
    // for the wrong one is that far off on expenses.
    avgOpEx: 35,
    avgCapRate: 7.5,
    constructionCostPSF: { groundUp: 250, ti: 75, acquisition: 60 },
    // Owner-operated; no tenant to reimburse.
    expenseRecoveryRate: 0,
    leaseUpMonths: 9,          // membership ramp
    capexReservePerSF: 0.35,
  },
  multifamily: {
    name: 'Multifamily',
    color: '#059669',
    revenueBasis: 'unit',      // annual revenue per unit
    avgRevenue: 24000,
    avgOpEx: 45,
    avgCapRate: 5.5,
    constructionCostPSF: { groundUp: 180, ti: 45, acquisition: 35 },
    // Gross leases; the landlord carries taxes and operating cost.
    expenseRecoveryRate: 0,
    leaseUpMonths: 15,
    capexReservePerSF: 0.30,
    capexReservePerUnit: 300,
  },
  office: {
    name: 'Office',
    color: '#3b82f6',
    revenueBasis: 'psf',       // annual revenue per SF
    avgRevenue: 28,
    avgOpEx: 40,
    avgCapRate: 6.5,
    constructionCostPSF: { groundUp: 200, ti: 85, acquisition: 55 },
    // Base-year stops recover roughly half of expense growth in practice.
    expenseRecoveryRate: 0.55,
    leaseUpMonths: 24,
    capexReservePerSF: 0.25,
  },
  retail: {
    name: 'Retail',
    color: '#dc2626',
    revenueBasis: 'psf',
    avgRevenue: 22,
    avgOpEx: 38,
    avgCapRate: 7.0,
    constructionCostPSF: { groundUp: 175, ti: 65, acquisition: 45 },
    // NNN: tenants reimburse CAM, insurance and taxes pro rata.
    expenseRecoveryRate: 0.90,
    leaseUpMonths: 12,
    capexReservePerSF: 0.20,
  },
  industrial: {
    name: 'Industrial',
    color: '#ea580c',
    revenueBasis: 'psf',
    avgRevenue: 8,
    avgOpEx: 25,
    avgCapRate: 7.5,
    constructionCostPSF: { groundUp: 120, ti: 35, acquisition: 25 },
    // NNN: near-full reimbursement is the market standard.
    expenseRecoveryRate: 0.95,
    leaseUpMonths: 9,
    capexReservePerSF: 0.15,
  },
};

export const constructionTypes = {
  groundUp: {
    name: 'Ground-Up Development',
    timeframe: 18,
    contingency: 0.15,
    softCostPct: 0.14,
    // Ground-up carries no in-place income during construction.
    hasInPlaceIncome: false,
  },
  ti: {
    name: 'Tenant Improvement',
    timeframe: 6,
    contingency: 0.08,
    softCostPct: 0.08,
    hasInPlaceIncome: true,
  },
  acquisition: {
    name: 'Acquisition / Renovation',
    timeframe: 12,
    contingency: 0.10,
    softCostPct: 0.06,
    hasInPlaceIncome: true,
  },
};

/**
 * Suggested stabilized annual gross revenue for a program.
 * Replaces the previous placeholder helper, which multiplied by SF and then
 * divided the same SF back out — yielding "$28" as a suggested annual revenue.
 */
export function suggestGrossRevenue({ propertyType, buildingSize = 0, units = 0 }) {
  const type = propertyTypes[propertyType];
  if (!type) return 0;
  switch (type.revenueBasis) {
    case 'site': return type.avgRevenue;
    case 'unit': return type.avgRevenue * (units || 0);
    case 'psf':  return type.avgRevenue * (buildingSize || 0);
    default:     return 0;
  }
}

export function suggestConstructionCost({ propertyType, constructionType, buildingSize = 0 }) {
  const type = propertyTypes[propertyType];
  if (!type) return 0;
  const psf = type.constructionCostPSF[constructionType];
  return (psf || 0) * (buildingSize || 0);
}
