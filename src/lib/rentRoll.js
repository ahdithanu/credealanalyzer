/**
 * The rent roll — what makes a strip centre different from a box with a cap rate.
 *
 * The engine in finance.js prices a retail deal from rent per square foot times
 * building size. That is the right shape for a single-tenant NNN box and it is
 * the wrong shape for a 5-to-12-bay neighbourhood centre, because every question
 * that distinguishes a good one from a bad one is a question about the LEASES:
 *
 *   - Is any one tenant big enough that losing them breaks the deal?
 *   - How much of the rent rolls over in the next 24 months?
 *   - Is the in-place rent above market, so renewals reset DOWN?
 *   - How much of the income is restaurants, with their turnover and buildout?
 *
 * None of those can be answered from an aggregate. A centre at $18/SF with a
 * 4.1-year WALT and no tenant over 18% of rent, and a centre at $18/SF whose
 * anchor is 44% of rent on a lease expiring in fourteen months, screen
 * identically and are not the same deal.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS NOT
 *
 * It is not a valuation. It computes facts about a rent roll — sums, shares,
 * weighted averages, dates — and every one of them is arithmetic over what the
 * caller supplied. It does not estimate, does not fill gaps, and returns `null`
 * for any figure whose inputs are absent rather than a zero that reads as a
 * measurement. A WALT of `null` means nobody typed the lease dates; a WALT of
 * 0 would mean every lease has expired, and those must not look alike.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Finite number, or null. Never NaN, never a silent zero. */
function finite(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A date, or null. Accepts an ISO string or a Date. */
function when(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Tenant categories.
 *
 * `amazonResistant` is the property the buy box cares about: a tenant whose
 * service has to be delivered in person. A nail salon cannot be shipped; a
 * gift shop can. `restaurant` is tracked separately because the buy box caps
 * it for reasons that have nothing to do with e-commerce — turnover, grease
 * traps, and a buildout the landlord eats when they leave.
 */
export const TENANT_CATEGORIES = {
  salon:      { label: 'Salon / barber',      amazonResistant: true,  restaurant: false },
  medical:    { label: 'Medical / dental',    amazonResistant: true,  restaurant: false },
  urgentCare: { label: 'Urgent care',         amazonResistant: true,  restaurant: false },
  fitness:    { label: 'Fitness studio',      amazonResistant: true,  restaurant: false },
  professional: { label: 'Tax / insurance / professional', amazonResistant: true, restaurant: false },
  qsr:        { label: 'Quick-service food',  amazonResistant: true,  restaurant: true },
  restaurant: { label: 'Sit-down restaurant', amazonResistant: true,  restaurant: true },
  // Everything below can be bought online, which is the point of the flag.
  softGoods:  { label: 'Apparel / soft goods', amazonResistant: false, restaurant: false },
  generalRetail: { label: 'General retail',   amazonResistant: false, restaurant: false },
  other:      { label: 'Other',               amazonResistant: false, restaurant: false },
  vacant:     { label: 'Vacant',              amazonResistant: false, restaurant: false },
};

/**
 * One bay.
 *
 * @typedef {object} Bay
 * @property {string}  [tenant]      name; absent or `vacant: true` means empty
 * @property {boolean} [vacant]
 * @property {string}  [category]    a key of TENANT_CATEGORIES
 * @property {number}  squareFeet
 * @property {number}  [baseRentAnnual]  total annual base rent, not per SF
 * @property {string}  [leaseEnd]    ISO date
 * @property {string}  [leaseStart]  ISO date
 * @property {string}  [recovery]    'nnn' | 'modified' | 'gross'
 * @property {number}  [marketRentPSF] the caller's view of market for this bay
 */

/**
 * Analyse a rent roll.
 *
 * @param {Bay[]} bays
 * @param {object} [opts]
 * @param {Date|string} [opts.asOf]  defaults to now; pinned in tests
 * @returns an object of facts, each `null` where the inputs do not support it
 */
export function analyseRentRoll(bays = [], { asOf } = {}) {
  const today = when(asOf) || new Date();
  const rows = Array.isArray(bays) ? bays : [];

  // ── Space ────────────────────────────────────────────────────────────────
  const withSF = rows.filter((b) => finite(b.squareFeet) !== null);
  const totalSF = withSF.length
    ? withSF.reduce((s, b) => s + finite(b.squareFeet), 0)
    : null;

  const isVacant = (b) => b.vacant === true || b.category === 'vacant' || !b.tenant;
  const occupiedRows = rows.filter((b) => !isVacant(b));
  const vacantRows = rows.filter(isVacant);

  const occupiedSF = withSF.filter((b) => !isVacant(b))
    .reduce((s, b) => s + finite(b.squareFeet), 0);
  // Physical occupancy by AREA, which is the convention, not by bay count. Five
  // 1,200 SF bays let and one 6,000 SF bay empty is 50% occupied, and counting
  // bays would call it 83%.
  const occupancyPct = totalSF ? (occupiedSF / totalSF) * 100 : null;

  // ── Rent ─────────────────────────────────────────────────────────────────
  const withRent = occupiedRows.filter((b) => finite(b.baseRentAnnual) !== null);
  const grossBaseRent = withRent.length
    ? withRent.reduce((s, b) => s + finite(b.baseRentAnnual), 0)
    : null;

  // Rent per SF is quoted on OCCUPIED area, not total. Dividing by total area
  // blends the vacancy into the rate and produces a number that matches no
  // lease in the building and no comp in the market.
  const leasedSFWithRent = withRent.reduce((s, b) => s + (finite(b.squareFeet) || 0), 0);
  const inPlaceRentPSF = grossBaseRent !== null && leasedSFWithRent > 0
    ? grossBaseRent / leasedSFWithRent
    : null;

  // ── Concentration ────────────────────────────────────────────────────────
  /**
   * Each tenant's share of gross base rent, largest first.
   *
   * Grouped by tenant NAME, not by bay: one operator holding three adjacent
   * bays is one credit and one departure, and treating them as three tenants
   * is the arithmetic that makes a concentrated centre look diversified.
   */
  let tenants = null;
  let largestTenantShare = null;
  if (grossBaseRent !== null && grossBaseRent > 0) {
    const byName = new Map();
    for (const b of withRent) {
      const name = String(b.tenant).trim();
      const prev = byName.get(name) || { tenant: name, rent: 0, squareFeet: 0, bays: 0, category: b.category };
      prev.rent += finite(b.baseRentAnnual);
      prev.squareFeet += finite(b.squareFeet) || 0;
      prev.bays += 1;
      byName.set(name, prev);
    }
    tenants = [...byName.values()]
      .map((t) => ({ ...t, shareOfRentPct: (t.rent / grossBaseRent) * 100 }))
      .sort((a, b) => b.rent - a.rent);
    largestTenantShare = tenants[0]?.shareOfRentPct ?? null;
  }

  // ── Category mix ─────────────────────────────────────────────────────────
  let restaurantSharePct = null;
  let amazonResistantSharePct = null;
  let uncategorisedRent = 0;
  if (grossBaseRent !== null && grossBaseRent > 0) {
    let restaurant = 0;
    let resistant = 0;
    for (const b of withRent) {
      const cat = TENANT_CATEGORIES[b.category];
      const rent = finite(b.baseRentAnnual);
      if (!cat) { uncategorisedRent += rent; continue; }
      if (cat.restaurant) restaurant += rent;
      if (cat.amazonResistant) resistant += rent;
    }
    restaurantSharePct = (restaurant / grossBaseRent) * 100;
    amazonResistantSharePct = (resistant / grossBaseRent) * 100;
  }

  // ── Lease term ───────────────────────────────────────────────────────────
  /**
   * Weighted average lease term remaining, in years, weighted by RENT.
   *
   * Rent, not area: the question WALT answers is "how much of my income is
   * contracted, and for how long", and a 2,400 SF bay at $12/SF is not the same
   * exposure as a 1,200 SF bay at $32/SF. Weighting by area answers a question
   * about the building instead of about the income.
   *
   * Expired leases contribute ZERO rather than a negative number. A tenant
   * holding over month-to-month has no contracted term left; letting them
   * subtract from the average would make a roll of holdovers look shorter than
   * a roll of vacancies, which is backwards — the holdover is still paying.
   */
  const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
  const datedRows = withRent.filter((b) => when(b.leaseEnd) !== null);
  let waltYears = null;
  let rentWithDates = 0;
  if (datedRows.length) {
    let weighted = 0;
    for (const b of datedRows) {
      const rent = finite(b.baseRentAnnual);
      const years = Math.max(0, (when(b.leaseEnd) - today) / YEAR_MS);
      weighted += rent * years;
      rentWithDates += rent;
    }
    waltYears = rentWithDates > 0 ? weighted / rentWithDates : null;
  }

  /**
   * How much of the rent expires in each of the next five years.
   *
   * The number that matters more than WALT on a small centre: an average of
   * 3.2 years is comfortable unless 60% of it lands in month 14, and an
   * average cannot show that.
   */
  let rolloverByYear = null;
  if (datedRows.length && grossBaseRent) {
    rolloverByYear = [1, 2, 3, 4, 5].map((y) => {
      const from = new Date(today.getTime() + (y - 1) * YEAR_MS);
      const to = new Date(today.getTime() + y * YEAR_MS);
      const rent = datedRows
        .filter((b) => when(b.leaseEnd) >= from && when(b.leaseEnd) < to)
        .reduce((s, b) => s + finite(b.baseRentAnnual), 0);
      return { year: y, rent, shareOfRentPct: (rent / grossBaseRent) * 100 };
    });
  }

  // Already expired, i.e. holding over. Called out separately because it is
  // neither contracted term nor vacancy and gets lost inside both.
  const holdoverRent = datedRows
    .filter((b) => when(b.leaseEnd) < today)
    .reduce((s, b) => s + finite(b.baseRentAnnual), 0);

  // ── In place versus market ───────────────────────────────────────────────
  /**
   * Above-market rent is the trap the buy box names: it looks like income in
   * the offering memorandum and resets down at renewal. Only computed over the
   * bays where the caller supplied a market rent — a partial answer labelled as
   * partial, rather than a whole one resting on guesses.
   */
  let rentVsMarketPct = null;
  let marketCoverageOfRentPct = null;
  const marketRows = withRent.filter(
    (b) => finite(b.marketRentPSF) !== null && finite(b.squareFeet),
  );
  if (marketRows.length && grossBaseRent > 0) {
    const inPlace = marketRows.reduce((s, b) => s + finite(b.baseRentAnnual), 0);
    const atMarket = marketRows.reduce(
      (s, b) => s + finite(b.marketRentPSF) * finite(b.squareFeet), 0,
    );
    rentVsMarketPct = atMarket > 0 ? ((inPlace / atMarket) - 1) * 100 : null;
    marketCoverageOfRentPct = (inPlace / grossBaseRent) * 100;
  }

  // ── Recovery ─────────────────────────────────────────────────────────────
  let nnnShareOfRentPct = null;
  if (grossBaseRent !== null && grossBaseRent > 0) {
    const net = withRent
      .filter((b) => b.recovery === 'nnn' || b.recovery === 'modified')
      .reduce((s, b) => s + finite(b.baseRentAnnual), 0);
    nnnShareOfRentPct = (net / grossBaseRent) * 100;
  }

  return {
    bayCount: rows.length,
    occupiedBays: occupiedRows.length,
    vacantBays: vacantRows.length,
    totalSF,
    occupiedSF: totalSF === null ? null : occupiedSF,
    vacantSF: totalSF === null ? null : totalSF - occupiedSF,
    occupancyPct,
    grossBaseRent,
    inPlaceRentPSF,
    tenants,
    largestTenantShare,
    restaurantSharePct,
    amazonResistantSharePct,
    // Rent the caller gave no category for. A mix reported over 80% of the rent
    // is a different claim from one reported over all of it.
    uncategorisedSharePct: grossBaseRent > 0 ? (uncategorisedRent / grossBaseRent) * 100 : null,
    waltYears,
    // What share of the rent WALT was actually computed over, so a 4.8-year
    // WALT derived from two of nine leases cannot be read as the whole roll.
    waltCoverageOfRentPct: grossBaseRent > 0 ? (rentWithDates / grossBaseRent) * 100 : null,
    rolloverByYear,
    holdoverRent,
    holdoverSharePct: grossBaseRent > 0 ? (holdoverRent / grossBaseRent) * 100 : null,
    rentVsMarketPct,
    marketCoverageOfRentPct,
    nnnShareOfRentPct,
  };
}

/**
 * Bridge to the engine: turn a rent roll into the aggregate inputs runModel()
 * already understands.
 *
 * This is how a rent roll becomes an IRR without rewriting finance.js. What it
 * hands over is deliberately thin — gross revenue, building size, occupancy —
 * because those are the only things the monthly schedule consumes, and a
 * richer bridge would imply the engine is modelling leases when it is not.
 *
 * THE LIMIT, stated because it is the thing to remember when reading the
 * output: the engine escalates one blended rent line. It does not know that
 * 38% of the income expires in year two, so it does not model that rollover,
 * the downtime around it, or the leasing cost of replacing it. Read
 * `rolloverByYear` alongside the IRR, not instead of it.
 */
export function engineInputsFromRentRoll(bays, opts) {
  const r = analyseRentRoll(bays, opts);
  if (r.grossBaseRent === null || r.totalSF === null) return null;
  return {
    buildingSize: r.totalSF,
    // Gross POTENTIAL revenue: what the centre earns fully let, which is what
    // the engine expects and what it applies its own vacancy factor to. Passing
    // in-place rent here would apply vacancy twice.
    grossRevenue: r.inPlaceRentPSF !== null ? r.inPlaceRentPSF * r.totalSF : null,
    // The vacancy that is actually there, not the house assumption.
    vacancyRate: r.occupancyPct === null ? null : 100 - r.occupancyPct,
    // Recovery from the leases rather than the property-type default. A centre
    // whose leases are half gross does not recover 90%.
    expenseRecoveryRate: r.nnnShareOfRentPct === null
      ? null
      : Math.round(r.nnnShareOfRentPct) / 100,
  };
}
