/**
 * Illustrative sample deals, seeded only on a user's first visit.
 *
 * These replace the original samples, which paired ~$580K of revenue with a
 * ~$2.1M all-in basis and therefore produced a 15.6% yield on cost, an 841 bps
 * development spread and a 7.15x equity multiple. Those are not achievable
 * outcomes, and shipping them as the default view teaches users that a 40% IRR
 * is normal.
 *
 * IMPORTANT CONVENTION: `operatingExpenseRatio` EXCLUDES property tax, which
 * the engine computes separately from the market's effective rate. A
 * multifamily "45% opex ratio" quoted in the market usually INCLUDES taxes; the
 * ex-tax equivalent is closer to 30-33%. Mixing the two conventions double-
 * counts the single largest expense line in Texas.
 *
 * Figures are plausible and internally consistent, not sourced comps.
 */
export const SAMPLE_DEALS = [
  {
    id: 1,
    name: 'Houston Express Tunnel',
    propertyType: 'carwash',
    constructionType: 'groundUp',
    location: 'Houston, TX',
    purchasePrice: 1_400_000,
    constructionCost: 3_900_000,
    buildingSize: 4_800,
    grossRevenue: 1_510_000,
    vacancyRate: 3,
    operatingExpenseRatio: 45,
    downPayment: 30,
    interestRate: 6.8,
    loanTerm: 25,
    exitCapRate: 7.2,
    holdPeriod: 5,
    notes: 'Single-tunnel express with 22 vacuum stalls. Membership ramp assumed over 9 months.',
  },
  {
    id: 2,
    name: 'Austin Multifamily Development',
    propertyType: 'multifamily',
    constructionType: 'groundUp',
    location: 'Austin, TX',
    purchasePrice: 1_800_000,
    constructionCost: 11_160_000,
    buildingSize: 72_000,
    units: 80,
    grossRevenue: 2_016_000,
    vacancyRate: 5,
    operatingExpenseRatio: 32,
    downPayment: 35,
    interestRate: 6.2,
    loanTerm: 30,
    exitCapRate: 5.8,
    holdPeriod: 7,
    notes: 'Thin spread. Austin supply pipeline is the heaviest in the peer set — see Market Intelligence.',
  },
  {
    id: 3,
    name: 'Dallas Office TI',
    propertyType: 'office',
    constructionType: 'ti',
    location: 'Dallas, TX',
    purchasePrice: 3_200_000,
    constructionCost: 2_125_000,
    buildingSize: 25_000,
    grossRevenue: 750_000,
    vacancyRate: 8,
    operatingExpenseRatio: 28,
    downPayment: 30,
    interestRate: 5.9,
    loanTerm: 25,
    exitCapRate: 7.8,
    holdPeriod: 5,
    notes: 'Second-generation space, full-floor TI at $85/SF.',
  },
  {
    id: 4,
    name: 'Miami Express Wash',
    propertyType: 'carwash',
    constructionType: 'groundUp',
    location: 'Miami, FL',
    purchasePrice: 3_000_000,
    constructionCost: 4_300_000,
    buildingSize: 5_200,
    grossRevenue: 1_450_000,
    vacancyRate: 2,
    operatingExpenseRatio: 43,
    downPayment: 35,
    interestRate: 6.5,
    loanTerm: 25,
    exitCapRate: 6.8,
    holdPeriod: 5,
    notes: 'Coastal land basis compresses the spread despite a materially lower Florida tax burden than the Texas sites.',
  },
  {
    id: 5,
    name: 'Tampa Retail Center Repositioning',
    propertyType: 'retail',
    constructionType: 'acquisition',
    location: 'Tampa, FL',
    purchasePrice: 6_400_000,
    constructionCost: 1_100_000,
    buildingSize: 18_000,
    grossRevenue: 900_000,
    vacancyRate: 6,
    operatingExpenseRatio: 26,
    downPayment: 30,
    interestRate: 6.1,
    loanTerm: 25,
    exitCapRate: 7.0,
    holdPeriod: 5,
    assumptions: { inPlaceRevenue: 620_000 },
    notes: 'Value-add acquisition. In-place income services debt through the 12-month renovation.',
  },
];
