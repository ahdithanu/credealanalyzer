/**
 * Market reference data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DATA PROVENANCE — READ BEFORE SHIPPING TO CUSTOMERS
 *
 * The `effectiveTaxRate` values are carried over from the original application.
 * Every other feature on these records is DIRECTIONAL SEED DATA: plausible
 * ordering for development and demos, but NOT sourced, NOT current, and NOT
 * suitable for underwriting a real deal or for presentation to an investment
 * committee.
 *
 * Each record carries a `provenance` block. The UI must surface it, and the
 * scoring layer must degrade visibly when `dataQuality !== 'sourced'`.
 *
 * Replacement path (in priority order):
 *   - Tax rates            -> county assessor / TAD, DCAD, HCAD, FL DOR rolls
 *   - Population / income  -> Census ACS 5-year, BLS QCEW
 *   - Employment growth    -> BLS CES, state workforce commissions
 *   - Supply pipeline      -> CoStar, Yardi Matrix, permit feeds
 *   - Market cap rates     -> CBRE / JLL cap rate surveys, RCA comps
 *   - Traffic counts       -> TxDOT / FDOT AADT station data
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SEED_PROVENANCE = {
  dataQuality: 'seed',
  source: 'Directional seed data — replace with sourced feed before production use',
  asOf: null,
};

/**
 * @typedef {Object} Market
 * @property {string} key            Canonical slug
 * @property {string} city
 * @property {string} state
 * @property {number} lat
 * @property {number} lng
 * @property {number} effectiveTaxRate      Annual property tax, % of assessed value
 * @property {number} population            Metro population
 * @property {number} popGrowth5y           5-yr population CAGR, %
 * @property {number} employmentGrowth      Trailing employment growth, %
 * @property {number} medianHHI             Median household income, $
 * @property {number} supplyPipeline        Under construction as % of inventory
 * @property {number} rentGrowth            Trailing market rent growth, %
 * @property {number} trafficCount          Representative arterial AADT (car wash / retail)
 * @property {Object} marketCapRate         Market cap rate by property type, %
 */
export const markets = [
  { key: 'houston-tx',        city: 'Houston',         state: 'TX', lat: 29.7604, lng: -95.3698, effectiveTaxRate: 2.81, population: 7340000, popGrowth5y: 1.9, employmentGrowth: 2.4, medianHHI: 72000, supplyPipeline: 2.8, rentGrowth: 3.1, trafficCount: 42000, marketCapRate: { carwash: 7.6, multifamily: 5.6, office: 8.1, retail: 7.1, industrial: 6.6 } },
  { key: 'dallas-tx',         city: 'Dallas',          state: 'TX', lat: 32.7767, lng: -96.7970, effectiveTaxRate: 2.42, population: 7940000, popGrowth5y: 2.2, employmentGrowth: 2.8, medianHHI: 78000, supplyPipeline: 3.6, rentGrowth: 3.4, trafficCount: 48000, marketCapRate: { carwash: 7.3, multifamily: 5.3, office: 7.8, retail: 6.8, industrial: 6.2 } },
  { key: 'austin-tx',         city: 'Austin',          state: 'TX', lat: 30.2672, lng: -97.7431, effectiveTaxRate: 2.23, population: 2470000, popGrowth5y: 2.9, employmentGrowth: 3.1, medianHHI: 91000, supplyPipeline: 6.2, rentGrowth: 1.4, trafficCount: 39000, marketCapRate: { carwash: 7.0, multifamily: 5.0, office: 7.9, retail: 6.5, industrial: 6.0 } },
  { key: 'san-antonio-tx',    city: 'San Antonio',     state: 'TX', lat: 29.4241, lng: -98.4936, effectiveTaxRate: 2.34, population: 2650000, popGrowth5y: 1.8, employmentGrowth: 2.1, medianHHI: 64000, supplyPipeline: 3.1, rentGrowth: 2.6, trafficCount: 35000, marketCapRate: { carwash: 7.7, multifamily: 5.8, office: 8.3, retail: 7.2, industrial: 6.8 } },
  { key: 'fort-worth-tx',     city: 'Fort Worth',      state: 'TX', lat: 32.7555, lng: -97.3308, effectiveTaxRate: 2.38, population: 2400000, popGrowth5y: 2.4, employmentGrowth: 2.6, medianHHI: 74000, supplyPipeline: 3.3, rentGrowth: 3.2, trafficCount: 37000, marketCapRate: { carwash: 7.4, multifamily: 5.5, office: 8.0, retail: 6.9, industrial: 6.3 } },
  { key: 'plano-tx',          city: 'Plano',           state: 'TX', lat: 33.0198, lng: -96.6989, effectiveTaxRate: 2.15, population: 290000,  popGrowth5y: 1.1, employmentGrowth: 2.2, medianHHI: 105000, supplyPipeline: 2.4, rentGrowth: 2.9, trafficCount: 44000, marketCapRate: { carwash: 7.0, multifamily: 5.1, office: 7.6, retail: 6.4, industrial: 6.1 } },
  { key: 'arlington-tx',      city: 'Arlington',       state: 'TX', lat: 32.7357, lng: -97.1081, effectiveTaxRate: 2.33, population: 400000,  popGrowth5y: 1.3, employmentGrowth: 1.9, medianHHI: 68000, supplyPipeline: 2.2, rentGrowth: 2.8, trafficCount: 41000, marketCapRate: { carwash: 7.5, multifamily: 5.6, office: 8.2, retail: 7.0, industrial: 6.5 } },
  { key: 'corpus-christi-tx', city: 'Corpus Christi',  state: 'TX', lat: 27.8006, lng: -97.3964, effectiveTaxRate: 2.45, population: 445000,  popGrowth5y: 0.4, employmentGrowth: 1.1, medianHHI: 60000, supplyPipeline: 1.6, rentGrowth: 2.1, trafficCount: 26000, marketCapRate: { carwash: 8.2, multifamily: 6.4, office: 9.0, retail: 7.8, industrial: 7.3 } },
  { key: 'lubbock-tx',        city: 'Lubbock',         state: 'TX', lat: 33.5779, lng: -101.8552, effectiveTaxRate: 2.28, population: 325000, popGrowth5y: 0.9, employmentGrowth: 1.3, medianHHI: 56000, supplyPipeline: 1.9, rentGrowth: 2.3, trafficCount: 24000, marketCapRate: { carwash: 8.3, multifamily: 6.5, office: 9.1, retail: 7.9, industrial: 7.5 } },
  { key: 'irving-tx',         city: 'Irving',          state: 'TX', lat: 32.8140, lng: -96.9489, effectiveTaxRate: 2.41, population: 260000,  popGrowth5y: 1.2, employmentGrowth: 2.3, medianHHI: 76000, supplyPipeline: 2.9, rentGrowth: 3.0, trafficCount: 46000, marketCapRate: { carwash: 7.4, multifamily: 5.4, office: 7.9, retail: 6.8, industrial: 6.2 } },
  { key: 'miami-fl',          city: 'Miami',           state: 'FL', lat: 25.7617, lng: -80.1918, effectiveTaxRate: 1.02, population: 6200000, popGrowth5y: 1.1, employmentGrowth: 2.2, medianHHI: 71000, supplyPipeline: 4.1, rentGrowth: 2.7, trafficCount: 51000, marketCapRate: { carwash: 6.8, multifamily: 4.8, office: 7.4, retail: 6.2, industrial: 5.7 } },
  { key: 'orlando-fl',        city: 'Orlando',         state: 'FL', lat: 28.5383, lng: -81.3792, effectiveTaxRate: 1.18, population: 2750000, popGrowth5y: 2.3, employmentGrowth: 2.9, medianHHI: 69000, supplyPipeline: 4.4, rentGrowth: 3.0, trafficCount: 43000, marketCapRate: { carwash: 7.1, multifamily: 5.2, office: 7.8, retail: 6.6, industrial: 6.0 } },
  { key: 'tampa-fl',          city: 'Tampa',           state: 'FL', lat: 27.9506, lng: -82.4572, effectiveTaxRate: 1.23, population: 3300000, popGrowth5y: 2.1, employmentGrowth: 2.7, medianHHI: 70000, supplyPipeline: 3.8, rentGrowth: 3.2, trafficCount: 40000, marketCapRate: { carwash: 7.2, multifamily: 5.2, office: 7.9, retail: 6.7, industrial: 6.1 } },
  { key: 'jacksonville-fl',   city: 'Jacksonville',    state: 'FL', lat: 30.3322, lng: -81.6557, effectiveTaxRate: 1.15, population: 1650000, popGrowth5y: 1.9, employmentGrowth: 2.4, medianHHI: 67000, supplyPipeline: 3.2, rentGrowth: 2.9, trafficCount: 36000, marketCapRate: { carwash: 7.5, multifamily: 5.6, office: 8.2, retail: 7.0, industrial: 6.4 } },
  { key: 'fort-lauderdale-fl',city: 'Fort Lauderdale', state: 'FL', lat: 26.1224, lng: -80.1373, effectiveTaxRate: 1.04, population: 1950000, popGrowth5y: 0.9, employmentGrowth: 2.0, medianHHI: 73000, supplyPipeline: 3.5, rentGrowth: 2.5, trafficCount: 47000, marketCapRate: { carwash: 6.9, multifamily: 4.9, office: 7.5, retail: 6.3, industrial: 5.8 } },
  { key: 'tallahassee-fl',    city: 'Tallahassee',     state: 'FL', lat: 30.4383, lng: -84.2807, effectiveTaxRate: 0.89, population: 390000,  popGrowth5y: 0.7, employmentGrowth: 1.2, medianHHI: 54000, supplyPipeline: 1.7, rentGrowth: 2.0, trafficCount: 22000, marketCapRate: { carwash: 8.1, multifamily: 6.2, office: 8.8, retail: 7.7, industrial: 7.2 } },
  { key: 'gainesville-fl',    city: 'Gainesville',     state: 'FL', lat: 29.6516, lng: -82.3248, effectiveTaxRate: 1.31, population: 345000,  popGrowth5y: 0.8, employmentGrowth: 1.4, medianHHI: 52000, supplyPipeline: 2.6, rentGrowth: 2.2, trafficCount: 25000, marketCapRate: { carwash: 8.0, multifamily: 6.0, office: 8.6, retail: 7.5, industrial: 7.0 } },
  { key: 'pensacola-fl',      city: 'Pensacola',       state: 'FL', lat: 30.4213, lng: -87.2169, effectiveTaxRate: 0.95, population: 510000,  popGrowth5y: 1.4, employmentGrowth: 1.8, medianHHI: 59000, supplyPipeline: 2.1, rentGrowth: 2.6, trafficCount: 28000, marketCapRate: { carwash: 7.9, multifamily: 5.9, office: 8.5, retail: 7.4, industrial: 6.9 } },
  { key: 'clearwater-fl',     city: 'Clearwater',      state: 'FL', lat: 27.9659, lng: -82.8001, effectiveTaxRate: 1.08, population: 118000,  popGrowth5y: 0.6, employmentGrowth: 1.7, medianHHI: 62000, supplyPipeline: 2.3, rentGrowth: 2.7, trafficCount: 33000, marketCapRate: { carwash: 7.4, multifamily: 5.5, office: 8.1, retail: 6.9, industrial: 6.3 } },
  { key: 'west-palm-beach-fl',city: 'West Palm Beach', state: 'FL', lat: 26.7153, lng: -80.0534, effectiveTaxRate: 1.12, population: 1500000, popGrowth5y: 1.6, employmentGrowth: 2.3, medianHHI: 79000, supplyPipeline: 3.4, rentGrowth: 2.8, trafficCount: 38000, marketCapRate: { carwash: 7.0, multifamily: 5.0, office: 7.6, retail: 6.4, industrial: 5.9 } },
].map((m) => ({ ...m, provenance: { ...SEED_PROVENANCE } }));

export const DEFAULT_TAX_RATE = 1.5;

const byKey = new Map(markets.map((m) => [m.key, m]));

/** State-level fallbacks, used when a location names a state but no known city. */
const stateFallbackTaxRate = { tx: 2.35, texas: 2.35, fl: 1.08, florida: 1.08 };

function normalize(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Resolve a free-text location ("Houston, TX") to a market record.
 * Returns null when no confident match exists — callers must handle the miss
 * rather than silently underwriting against a default.
 */
export function findMarket(location) {
  const q = normalize(location);
  if (!q) return null;
  // Exact "city, st" or bare city match first.
  for (const m of markets) {
    const city = normalize(m.city);
    if (q === city || q === `${city}, ${normalize(m.state)}` || q === `${city} ${normalize(m.state)}`) {
      return m;
    }
  }
  // Substring match, longest city name first so "north miami" doesn't beat "miami"
  // and "fort lauderdale" isn't shadowed by a shorter entry.
  const ranked = [...markets].sort((a, b) => b.city.length - a.city.length);
  for (const m of ranked) {
    if (q.includes(normalize(m.city))) return m;
  }
  return null;
}

export function getMarket(key) {
  return byKey.get(key) || null;
}

/**
 * Effective annual property tax rate (% of assessed value) for a location.
 * Falls back to state, then to DEFAULT_TAX_RATE.
 */
export function getPropertyTaxRate(location) {
  const market = findMarket(location);
  if (market) return market.effectiveTaxRate;
  const q = normalize(location);
  for (const [name, rate] of Object.entries(stateFallbackTaxRate)) {
    if (q === name || q.endsWith(`, ${name}`) || q.endsWith(` ${name}`)) return rate;
  }
  return DEFAULT_TAX_RATE;
}

/** Describes how a tax rate was resolved, so the UI can show confidence. */
export function resolveTaxRate(location) {
  const market = findMarket(location);
  if (market) {
    return { rate: market.effectiveTaxRate, basis: 'market', market, provenance: market.provenance };
  }
  const q = normalize(location);
  for (const [name, rate] of Object.entries(stateFallbackTaxRate)) {
    if (q === name || q.endsWith(`, ${name}`) || q.endsWith(` ${name}`)) {
      return { rate, basis: 'state', market: null, provenance: { ...SEED_PROVENANCE } };
    }
  }
  return { rate: DEFAULT_TAX_RATE, basis: 'default', market: null, provenance: { ...SEED_PROVENANCE } };
}

/** Great-circle distance in miles. */
export function distanceMiles(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
