/**
 * Illustrative sample portfolio, seeded only on a user's first visit.
 *
 * These replace the original samples, which paired ~$580K of revenue with a
 * ~$2.1M all-in basis and so produced a 15.6% yield on cost, an 841 bps
 * development spread and a 7.15x equity multiple. Those are not achievable
 * outcomes, and shipping them as the default view teaches users that a 40% IRR
 * is normal.
 *
 * CONVENTIONS, both of which double-count if mixed up:
 *  - `operatingExpenseRatio` EXCLUDES property tax, which the engine computes
 *    separately from the market's effective rate.
 *  - For NNN property types (retail, industrial, office) `grossRevenue` is BASE
 *    RENT only. Expense reimbursements are modelled separately via the property
 *    type's `expenseRecoveryRate`, so they must not be baked into revenue.
 *
 * Figures are plausible and internally consistent, not sourced comps.
 *
 * The repositioning deals (Tampa, Plano, Alamo Ridge, Dallas) are priced
 * against a renovation period that carries property tax, capital reserves and
 * fixed operating cost — the same NOI definition the operating schedule and the
 * going-in cap rate use. Alamo Ridge was priced under the earlier convention,
 * which credited in-place income net of operating expense alone; at $135K/door
 * it read a 5.08% going-in cap into a 6.30% loan and breached the 1.25x
 * coverage covenant on a deal presented as heading to committee. $121K/door is
 * the basis at which a 2014-vintage San Antonio value-add actually clears its
 * own credit box.
 *
 * Austin is thin ON PURPOSE and is meant to fail: a negative development
 * spread and a coverage breach, in the market carrying the heaviest supply
 * pipeline in the peer set. A sample portfolio of nine winners teaches an
 * analyst that the screen never fires.
 *
 * ─── WHAT THREE ENGINE CHANGES DID TO THESE NUMBERS ──────────────────────────
 *
 * FIXED OPERATING COST no longer flexes with the deal's own vacancy; it is
 * anchored to the firm's house vacancy for the property type. A deal
 * underwritten ABOVE its house vacancy therefore carries more fixed cost than
 * it used to, and one below carries less. Houston (3% vs a 3% house), Austin
 * and Katy (5% vs 5%) are unmoved on opex; Plano (12 vs 10), Alamo (7 vs 5) and
 * Corpus (8 vs 7) lost NOI; Dallas (8 vs 10) and Miami (2 vs 3) gained it.
 *
 * ALAMO RIDGE consequently sits at a 97 bps development spread against the
 * 100 bps floor and now raises a WARNING it did not raise before. It is
 * documented here rather than tuned away, for the same reason Austin is: the
 * deal genuinely got thinner when it stopped budgeting 1.4 points less fixed
 * operating cost than the house standard, and moving its basis to recover three
 * basis points would hide exactly the effect the change exists to show. Tampa
 * (94 bps), Corpus (55) and Katy (46) already carry the same warning. Alamo's
 * $121K/door basis still clears its DSCR, debt yield and leverage tests.
 *
 * GROUND-UP LAND CARRY is now an explicit budget line — a jurisdiction rate on
 * the land basis over the build duration — with the ground-up soft cost load
 * relieved of the flat percentage that was standing in for it. Houston and
 * Corpus, land-heavy against a light hard cost in high-tax counties, got more
 * expensive; Katy, Austin and Miami got cheaper. Nothing changed on the four
 * repositioning deals, whose land tax always arrived through the renovation P&L.
 *
 * EQUITY is struck on TOTAL project cost, the basis the loan-to-cost covenant
 * measures, so every deal now funds exactly its stated leverage. Houston and
 * Dallas previously reported 70.89% LTC on a 30% cheque and raised a flag
 * neither deserved: the equity was struck on base cost, leaving the residual
 * loan above the limit by the whole interest reserve.
 *
 * IRR UNIQUENESS: Tampa, Plano and Alamo have levered equity series with three
 * sign changes — in-place income distributes during renovation, the first
 * operating months run negative through lease-up, then the hold turns positive.
 * Several rates zero those NPVs. `returns.irrDiagnostics.levered.unique` is
 * false on those three, and a surface must not present their IRR as THE deal
 * return without saying so.
 */
export const SAMPLE_DEALS = [
  {
    id: 1,
    name: 'Houston Express Tunnel',
    propertyType: 'carwash', constructionType: 'groundUp', location: 'Houston, TX',
    stage: 'Under LOI', owner: 'Rivera', program: 'Single tunnel · 22 vac stalls',
    purchasePrice: 1_400_000, constructionCost: 3_900_000, buildingSize: 4_800,
    grossRevenue: 1_510_000, vacancyRate: 3, operatingExpenseRatio: 45,
    downPayment: 30, interestRate: 6.8, loanTerm: 25, exitCapRate: 7.2, holdPeriod: 5,
    entryCapRate: 7.4,
    notes: 'Membership ramp assumed over 9 months.',
  },
  {
    id: 2,
    name: 'Austin Multifamily Development',
    propertyType: 'multifamily', constructionType: 'groundUp', location: 'Austin, TX',
    stage: 'Screening', owner: 'Feld', program: '80 units · garden',
    purchasePrice: 1_800_000, constructionCost: 11_160_000, buildingSize: 72_000, units: 80,
    grossRevenue: 2_016_000, vacancyRate: 5, operatingExpenseRatio: 32,
    downPayment: 35, interestRate: 6.2, loanTerm: 30, exitCapRate: 5.8, holdPeriod: 7,
    notes: 'Thin spread. Austin carries the heaviest supply pipeline in the peer set.',
  },
  {
    id: 3,
    name: 'Dallas Office TI',
    propertyType: 'office', constructionType: 'ti', location: 'Dallas, TX',
    stage: 'IC Thursday', owner: 'Rivera', program: '25,000 sf · full floor',
    purchasePrice: 3_200_000, constructionCost: 2_125_000, buildingSize: 25_000,
    grossRevenue: 700_000, vacancyRate: 8, operatingExpenseRatio: 28,
    downPayment: 30, interestRate: 5.9, loanTerm: 25, exitCapRate: 7.8, holdPeriod: 5,
    notes: 'Second-generation space at $85/sf TI. Vacant through the six-month fit-out, so tax and fixed opex are carried with no rent against them. Base-year stops recover ~55% of expense growth.',
  },
  {
    id: 4,
    name: 'Miami Express Wash',
    propertyType: 'carwash', constructionType: 'groundUp', location: 'Miami, FL',
    stage: 'Under LOI', owner: 'Okonjo', program: 'Single tunnel · coastal infill',
    purchasePrice: 3_000_000, constructionCost: 4_300_000, buildingSize: 5_200,
    grossRevenue: 1_450_000, vacancyRate: 2, operatingExpenseRatio: 43,
    downPayment: 35, interestRate: 6.5, loanTerm: 25, exitCapRate: 6.8, holdPeriod: 5,
    notes: 'Coastal land basis compresses the spread despite a low Florida tax burden.',
  },
  {
    id: 5,
    name: 'Tampa Retail Repositioning',
    propertyType: 'retail', constructionType: 'acquisition', location: 'Tampa, FL',
    stage: 'Closed', owner: 'Feld', program: '18,000 sf · grocery-anchored',
    purchasePrice: 5_200_000, constructionCost: 1_100_000, buildingSize: 18_000,
    grossRevenue: 558_000, vacancyRate: 6, operatingExpenseRatio: 20,
    downPayment: 30, interestRate: 6.1, loanTerm: 25, exitCapRate: 7.0, holdPeriod: 5,
    assumptions: { inPlaceRevenue: 400_000 },
    notes: 'Value-add acquisition at $31/sf NNN. In-place income, net of tax and reserves and with NNN recoveries on let space, services debt through renovation.',
  },
  {
    id: 6,
    name: 'Katy Freeway Logistics',
    propertyType: 'industrial', constructionType: 'groundUp', location: 'Houston, TX',
    stage: 'Screening', owner: 'Rivera', program: '642,000 sf · 2 buildings',
    purchasePrice: 8_000_000, constructionCost: 61_000_000, buildingSize: 642_000,
    grossRevenue: 7_223_000, vacancyRate: 5, operatingExpenseRatio: 25,
    downPayment: 35, interestRate: 6.6, loanTerm: 25, exitCapRate: 6.9, holdPeriod: 7,
    notes: 'NNN at $11.25/sf. Reimbursements carry the Texas tax load.',
  },
  {
    id: 7,
    name: 'Plano North Campus',
    propertyType: 'office', constructionType: 'acquisition', location: 'Plano, TX',
    stage: 'Screening', owner: 'Rivera', program: '204,000 sf · office/flex',
    purchasePrice: 28_000_000, constructionCost: 6_800_000, buildingSize: 204_000,
    grossRevenue: 5_100_000, vacancyRate: 12, operatingExpenseRatio: 30,
    downPayment: 35, interestRate: 6.4, loanTerm: 25, exitCapRate: 8.2, holdPeriod: 7,
    assumptions: { inPlaceRevenue: 3_400_000 },
    notes: 'Discounted basis at $137/sf. Lease-up risk is the whole thesis.',
  },
  {
    id: 8,
    name: 'Alamo Ridge Apartments',
    propertyType: 'multifamily', constructionType: 'acquisition', location: 'San Antonio, TX',
    stage: 'IC Thursday', owner: 'Okonjo', program: '248 units · 2014 vintage',
    purchasePrice: 30_000_000, constructionCost: 3_100_000, buildingSize: 214_000, units: 248,
    grossRevenue: 4_910_000, vacancyRate: 7, operatingExpenseRatio: 33,
    downPayment: 32, interestRate: 6.3, loanTerm: 30, exitCapRate: 5.9, holdPeriod: 7,
    assumptions: { inPlaceRevenue: 4_100_000 },
    notes: 'Interior renovation programme across 248 units at ~$12.5K/door. Basis $121K/door against a 6.2% going-in cap.',
  },
  {
    id: 9,
    name: 'Corpus Christi Crossing',
    propertyType: 'retail', constructionType: 'groundUp', location: 'Corpus Christi, TX',
    stage: 'Under LOI', owner: 'Feld', program: '64,200 sf · unanchored strip',
    purchasePrice: 4_200_000, constructionCost: 11_200_000, buildingSize: 64_200,
    grossRevenue: 1_862_000, vacancyRate: 8, operatingExpenseRatio: 22,
    downPayment: 32, interestRate: 6.7, loanTerm: 25, exitCapRate: 7.8, holdPeriod: 6,
    notes: 'NNN at $29/sf. Highest tax burden in the peer set at 2.45%.',
  },
];

export const DEAL_STAGES = ['Screening', 'Under LOI', 'IC Thursday', 'Closed'];
