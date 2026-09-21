/**
 * Market reference data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DATA PROVENANCE — READ BEFORE SHIPPING TO CUSTOMERS
 *
 * Provenance is PER FIELD, because a record is not uniformly anything. Three
 * qualities, weakest to strongest:
 *
 *   'seed'     a plausible number invented for demo ordering. Not sourced, not
 *              current, and not suitable for underwriting or for an IC memo.
 *   'estimate' a considered figure that would be defended within a stated
 *              tolerance — right to roughly half a point on a tax rate, right
 *              in its ORDERING against peer markets. Good enough to rank
 *              markets; not good enough to cite.
 *   'sourced'  pulled from a named public dataset, with the vintage recorded.
 *
 * A record's `dataQuality` is the WEAKEST of its fields, so nothing is upgraded
 * by the presence of one good number. Every record is `seed` today. The UI must
 * surface it, and the scoring layer must degrade visibly when it is not
 * `sourced`.
 *
 * Replacement path (in priority order):
 *   - Population / income  -> Census ACS 5-year, CBSA level. `npm run markets`
 *                             does this; it needs api.census.gov reachable.
 *   - Tax rates            -> county assessor / TAD, DCAD, HCAD, FL DOR rolls
 *   - Employment growth    -> BLS CES, state workforce commissions
 *   - Supply pipeline      -> CoStar, Yardi Matrix, permit feeds
 *   - Market cap rates     -> CBRE / JLL cap rate surveys, RCA comps
 *   - Traffic counts       -> state DOT AADT stations (src/lib/ingest/dot.js)
 *
 * ── TWO THINGS TO KNOW BEFORE READING A NUMBER OUT OF HERE ───────────────────
 *
 * THE TAX RATE IS A COMMERCIAL RATE, AND IT HAD TO BE. finance.js applies this
 * to a commercial deal, and in half of these states the commercial and
 * residential effective rates are not the same number: Indiana's circuit
 * breaker caps homestead at 1% of gross assessed value and commercial at 3%;
 * Cook County assesses commercial at 25% of market value against residential's
 * 10%; Michigan adds 18 mills of school operating levy to non-homestead
 * property. A residential effective rate — which is what a search returns, and
 * what most published "property tax by metro" tables mean — understates the tax
 * on a strip centre by a third in those places. The Midwest rates here are
 * commercial. The Texas and Florida rates came from the predecessor
 * application and their basis is not recorded; Texas assesses every class at
 * market value so the distinction does not arise there, but Florida's Save Our
 * Homes cap applies to homestead only, so a Florida rate that was struck on
 * residential data is LOW for commercial. Verify with the county before an LOI.
 *
 * `population` MIXES TWO BASES. It is documented as metro population, and for
 * the primary cities it is. Six records — plano-tx, arlington-tx, irving-tx,
 * clearwater-fl, and to a lesser degree gainesville-fl and tallahassee-fl —
 * carry CITY population for what is a submarket of a larger metro, so Plano
 * reads 290,000 against a Dallas–Fort Worth metro of 7.9M and scores in the
 * bottom decile on Market Scale while being a DFW submarket. `populationBasis`
 * records which basis each number is on rather than leaving the reader to infer
 * it from the size. The Midwest records are all metro.
 *
 * ── A NOTE ON WHAT ADDING A MARKET DOES ──────────────────────────────────────
 *
 * marketScore.js ranks by PERCENTILE WITHIN THE PEER SET, so adding a market
 * moves every other market's score. The Midwest records grow more slowly and
 * price wider than the Sunbelt ones, which lifts the Texas and Florida
 * percentiles on growth and compresses them on cap rate. That is the model
 * working — but until these numbers are sourced it means one set of invented
 * figures is re-ranking another, and a score is not evidence of anything until
 * `dataQuality` reads 'sourced'.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Explicit extension so `npm run markets` can import this module from plain
// Node without a build step. Vite resolves it identically.
import { SOURCED } from './marketsSourced.js';

/** Every field a market record carries data in. Provenance is tracked per entry. */
export const MARKET_DATA_FIELDS = [
  'population', 'popGrowth5y', 'employmentGrowth', 'medianHHI',
  'supplyPipeline', 'rentGrowth', 'trafficCount', 'marketCapRate',
  'effectiveTaxRate',
];

/** Weakest to strongest. `dataQuality` on a record is the weakest of its fields. */
export const DATA_QUALITY_ORDER = ['seed', 'estimate', 'sourced'];

const SEED_NOTE = 'Directional seed data — replace with sourced feed before production use';
const ESTIMATE_NOTE =
  'Considered estimate: ordering against peer markets is defended, level is not '
  + 'cited. Verify against the named source before an LOI or an IC memo.';

/**
 * Build a record's provenance from the fields that rise above seed.
 *
 * `dataQuality` is deliberately the MINIMUM rather than the maximum or a mean.
 * A record with a sourced population and an invented cap rate is not a sourced
 * record, and every consumer that branches on this one flag has to keep
 * degrading until the weakest field is fixed.
 *
 * `sourced` is a parameter rather than a closed-over lookup so the overlay
 * path can be tested. marketsSourced.js is empty until `npm run markets` runs
 * somewhere with network access, and an untestable merge is a merge that gets
 * discovered the first time it matters.
 */
export function buildRecord(base, estimated = [], sourced = SOURCED[base.key]) {
  const fields = {};
  for (const key of MARKET_DATA_FIELDS) {
    fields[key] = sourced?.fields?.[key] !== undefined ? 'sourced'
      : estimated.includes(key) ? 'estimate'
        : 'seed';
  }
  const dataQuality = DATA_QUALITY_ORDER.find((q) => Object.values(fields).includes(q))
    ?? 'sourced';
  return {
    ...base,
    // The overlay's values win where it has them, and it may also correct
    // `populationBasis`, which is carried as data rather than graded.
    ...(sourced?.fields || {}),
    provenance: {
      dataQuality,
      fields,
      source: dataQuality === 'seed' ? SEED_NOTE : ESTIMATE_NOTE,
      asOf: sourced?.asOf ?? null,
      ...(sourced?.cbsaName ? { cbsaName: sourced.cbsaName } : {}),
    },
  };
}

/**
 * How much of a market set is actually sourced, as a count per quality.
 *
 * Lives with the data rather than in the screen that renders it, because the
 * arithmetic is the part worth pinning: a banner that counts one market, or
 * counts an estimate as a citation, reads exactly like one that does not, and
 * with nothing sourced yet every wrong version of it prints the same 0%.
 *
 * `rows` is a parameter so the counting can be tested against a set that spans
 * the qualities the shipped table does not yet reach.
 */
export function dataQualityMix(rows = markets) {
  const counts = Object.fromEntries(DATA_QUALITY_ORDER.map((q) => [q, 0]));
  for (const m of rows) {
    for (const field of MARKET_DATA_FIELDS) counts[fieldQuality(m, field)] += 1;
  }
  const total = rows.length * MARKET_DATA_FIELDS.length;
  const share = (q) => (total ? (counts[q] / total) * 100 : 0);
  return {
    counts,
    total,
    markets: rows.length,
    sourcedPct: share('sourced'),
    estimatePct: share('estimate'),
    seedPct: share('seed'),
  };
}

/** Read one field's provenance. Unknown fields are not silently 'sourced'. */
export function fieldQuality(market, field) {
  return market?.provenance?.fields?.[field] ?? 'seed';
}

/**
 * The Texas and Florida records, carried over from the predecessor application.
 *
 * Only the tax rate rises above seed there, and only to 'estimate': the header
 * records that it came over from the original app, which is more than can be
 * said for the other eight fields but is not a citation.
 */
const SUNBELT_ESTIMATED = ['effectiveTaxRate'];

/**
 * The Midwest records.
 *
 * Metro population, 5-year population growth, median household income and the
 * commercial effective tax rate are estimates — widely published, stable, and
 * defended in their ordering. The other five need a feed: employment growth is
 * BLS, and supply pipeline, rent growth, traffic and cap rates have no free
 * equivalent at all.
 */
const MIDWEST_ESTIMATED = ['population', 'popGrowth5y', 'medianHHI', 'effectiveTaxRate'];

/**
 * @typedef {Object} Market
 * @property {string} key            Canonical slug
 * @property {string} city
 * @property {string} state
 * @property {number} lat
 * @property {number} lng
 * @property {'metro'|'city'} populationBasis  What `population` counts. See the header.
 * @property {number} effectiveTaxRate      Annual COMMERCIAL property tax, % of market value
 * @property {number} population            Population on `populationBasis`
 * @property {number} popGrowth5y           5-yr population CAGR, %
 * @property {number} employmentGrowth      Trailing employment growth, %
 * @property {number} medianHHI             Median household income, $
 * @property {number} supplyPipeline        Under construction as % of inventory
 * @property {number} rentGrowth            Trailing market rent growth, %
 * @property {number} trafficCount          Representative arterial AADT (car wash / retail)
 * @property {Object} marketCapRate         Market cap rate by property type, %
 * @property {Object} provenance            { dataQuality, fields, source, asOf }
 */

/** Texas and Florida, carried over from the predecessor application. */
const SUNBELT_MARKETS = [
  { key: 'houston-tx',        city: 'Houston',         state: 'TX', lat: 29.7604, lng: -95.3698, populationBasis: 'metro', effectiveTaxRate: 2.81, population: 7340000, popGrowth5y: 1.9, employmentGrowth: 2.4, medianHHI: 72000, supplyPipeline: 2.8, rentGrowth: 3.1, trafficCount: 42000, marketCapRate: { carwash: 7.6, multifamily: 5.6, office: 8.1, retail: 7.1, industrial: 6.6 } },
  { key: 'dallas-tx',         city: 'Dallas',          state: 'TX', lat: 32.7767, lng: -96.7970, populationBasis: 'metro', effectiveTaxRate: 2.42, population: 7940000, popGrowth5y: 2.2, employmentGrowth: 2.8, medianHHI: 78000, supplyPipeline: 3.6, rentGrowth: 3.4, trafficCount: 48000, marketCapRate: { carwash: 7.3, multifamily: 5.3, office: 7.8, retail: 6.8, industrial: 6.2 } },
  { key: 'austin-tx',         city: 'Austin',          state: 'TX', lat: 30.2672, lng: -97.7431, populationBasis: 'metro', effectiveTaxRate: 2.23, population: 2470000, popGrowth5y: 2.9, employmentGrowth: 3.1, medianHHI: 91000, supplyPipeline: 6.2, rentGrowth: 1.4, trafficCount: 39000, marketCapRate: { carwash: 7.0, multifamily: 5.0, office: 7.9, retail: 6.5, industrial: 6.0 } },
  { key: 'san-antonio-tx',    city: 'San Antonio',     state: 'TX', lat: 29.4241, lng: -98.4936, populationBasis: 'metro', effectiveTaxRate: 2.34, population: 2650000, popGrowth5y: 1.8, employmentGrowth: 2.1, medianHHI: 64000, supplyPipeline: 3.1, rentGrowth: 2.6, trafficCount: 35000, marketCapRate: { carwash: 7.7, multifamily: 5.8, office: 8.3, retail: 7.2, industrial: 6.8 } },
  { key: 'fort-worth-tx',     city: 'Fort Worth',      state: 'TX', lat: 32.7555, lng: -97.3308, populationBasis: 'metro', effectiveTaxRate: 2.38, population: 2400000, popGrowth5y: 2.4, employmentGrowth: 2.6, medianHHI: 74000, supplyPipeline: 3.3, rentGrowth: 3.2, trafficCount: 37000, marketCapRate: { carwash: 7.4, multifamily: 5.5, office: 8.0, retail: 6.9, industrial: 6.3 } },
  { key: 'plano-tx',          city: 'Plano',           state: 'TX', lat: 33.0198, lng: -96.6989, populationBasis: 'city', effectiveTaxRate: 2.15, population: 290000,  popGrowth5y: 1.1, employmentGrowth: 2.2, medianHHI: 105000, supplyPipeline: 2.4, rentGrowth: 2.9, trafficCount: 44000, marketCapRate: { carwash: 7.0, multifamily: 5.1, office: 7.6, retail: 6.4, industrial: 6.1 } },
  { key: 'arlington-tx',      city: 'Arlington',       state: 'TX', lat: 32.7357, lng: -97.1081, populationBasis: 'city', effectiveTaxRate: 2.33, population: 400000,  popGrowth5y: 1.3, employmentGrowth: 1.9, medianHHI: 68000, supplyPipeline: 2.2, rentGrowth: 2.8, trafficCount: 41000, marketCapRate: { carwash: 7.5, multifamily: 5.6, office: 8.2, retail: 7.0, industrial: 6.5 } },
  { key: 'corpus-christi-tx', city: 'Corpus Christi',  state: 'TX', lat: 27.8006, lng: -97.3964, populationBasis: 'metro', effectiveTaxRate: 2.45, population: 445000,  popGrowth5y: 0.4, employmentGrowth: 1.1, medianHHI: 60000, supplyPipeline: 1.6, rentGrowth: 2.1, trafficCount: 26000, marketCapRate: { carwash: 8.2, multifamily: 6.4, office: 9.0, retail: 7.8, industrial: 7.3 } },
  { key: 'lubbock-tx',        city: 'Lubbock',         state: 'TX', lat: 33.5779, lng: -101.8552, populationBasis: 'metro', effectiveTaxRate: 2.28, population: 325000, popGrowth5y: 0.9, employmentGrowth: 1.3, medianHHI: 56000, supplyPipeline: 1.9, rentGrowth: 2.3, trafficCount: 24000, marketCapRate: { carwash: 8.3, multifamily: 6.5, office: 9.1, retail: 7.9, industrial: 7.5 } },
  { key: 'irving-tx',         city: 'Irving',          state: 'TX', lat: 32.8140, lng: -96.9489, populationBasis: 'city', effectiveTaxRate: 2.41, population: 260000,  popGrowth5y: 1.2, employmentGrowth: 2.3, medianHHI: 76000, supplyPipeline: 2.9, rentGrowth: 3.0, trafficCount: 46000, marketCapRate: { carwash: 7.4, multifamily: 5.4, office: 7.9, retail: 6.8, industrial: 6.2 } },
  { key: 'miami-fl',          city: 'Miami',           state: 'FL', lat: 25.7617, lng: -80.1918, populationBasis: 'metro', effectiveTaxRate: 1.02, population: 6200000, popGrowth5y: 1.1, employmentGrowth: 2.2, medianHHI: 71000, supplyPipeline: 4.1, rentGrowth: 2.7, trafficCount: 51000, marketCapRate: { carwash: 6.8, multifamily: 4.8, office: 7.4, retail: 6.2, industrial: 5.7 } },
  { key: 'orlando-fl',        city: 'Orlando',         state: 'FL', lat: 28.5383, lng: -81.3792, populationBasis: 'metro', effectiveTaxRate: 1.18, population: 2750000, popGrowth5y: 2.3, employmentGrowth: 2.9, medianHHI: 69000, supplyPipeline: 4.4, rentGrowth: 3.0, trafficCount: 43000, marketCapRate: { carwash: 7.1, multifamily: 5.2, office: 7.8, retail: 6.6, industrial: 6.0 } },
  { key: 'tampa-fl',          city: 'Tampa',           state: 'FL', lat: 27.9506, lng: -82.4572, populationBasis: 'metro', effectiveTaxRate: 1.23, population: 3300000, popGrowth5y: 2.1, employmentGrowth: 2.7, medianHHI: 70000, supplyPipeline: 3.8, rentGrowth: 3.2, trafficCount: 40000, marketCapRate: { carwash: 7.2, multifamily: 5.2, office: 7.9, retail: 6.7, industrial: 6.1 } },
  { key: 'jacksonville-fl',   city: 'Jacksonville',    state: 'FL', lat: 30.3322, lng: -81.6557, populationBasis: 'metro', effectiveTaxRate: 1.15, population: 1650000, popGrowth5y: 1.9, employmentGrowth: 2.4, medianHHI: 67000, supplyPipeline: 3.2, rentGrowth: 2.9, trafficCount: 36000, marketCapRate: { carwash: 7.5, multifamily: 5.6, office: 8.2, retail: 7.0, industrial: 6.4 } },
  { key: 'fort-lauderdale-fl',city: 'Fort Lauderdale', state: 'FL', lat: 26.1224, lng: -80.1373, populationBasis: 'metro', effectiveTaxRate: 1.04, population: 1950000, popGrowth5y: 0.9, employmentGrowth: 2.0, medianHHI: 73000, supplyPipeline: 3.5, rentGrowth: 2.5, trafficCount: 47000, marketCapRate: { carwash: 6.9, multifamily: 4.9, office: 7.5, retail: 6.3, industrial: 5.8 } },
  { key: 'tallahassee-fl',    city: 'Tallahassee',     state: 'FL', lat: 30.4383, lng: -84.2807, populationBasis: 'city', effectiveTaxRate: 0.89, population: 390000,  popGrowth5y: 0.7, employmentGrowth: 1.2, medianHHI: 54000, supplyPipeline: 1.7, rentGrowth: 2.0, trafficCount: 22000, marketCapRate: { carwash: 8.1, multifamily: 6.2, office: 8.8, retail: 7.7, industrial: 7.2 } },
  { key: 'gainesville-fl',    city: 'Gainesville',     state: 'FL', lat: 29.6516, lng: -82.3248, populationBasis: 'city', effectiveTaxRate: 1.31, population: 345000,  popGrowth5y: 0.8, employmentGrowth: 1.4, medianHHI: 52000, supplyPipeline: 2.6, rentGrowth: 2.2, trafficCount: 25000, marketCapRate: { carwash: 8.0, multifamily: 6.0, office: 8.6, retail: 7.5, industrial: 7.0 } },
  { key: 'pensacola-fl',      city: 'Pensacola',       state: 'FL', lat: 30.4213, lng: -87.2169, populationBasis: 'metro', effectiveTaxRate: 0.95, population: 510000,  popGrowth5y: 1.4, employmentGrowth: 1.8, medianHHI: 59000, supplyPipeline: 2.1, rentGrowth: 2.6, trafficCount: 28000, marketCapRate: { carwash: 7.9, multifamily: 5.9, office: 8.5, retail: 7.4, industrial: 6.9 } },
  { key: 'clearwater-fl',     city: 'Clearwater',      state: 'FL', lat: 27.9659, lng: -82.8001, populationBasis: 'city', effectiveTaxRate: 1.08, population: 118000,  popGrowth5y: 0.6, employmentGrowth: 1.7, medianHHI: 62000, supplyPipeline: 2.3, rentGrowth: 2.7, trafficCount: 33000, marketCapRate: { carwash: 7.4, multifamily: 5.5, office: 8.1, retail: 6.9, industrial: 6.3 } },
  { key: 'west-palm-beach-fl',city: 'West Palm Beach', state: 'FL', lat: 26.7153, lng: -80.0534, populationBasis: 'metro', effectiveTaxRate: 1.12, population: 1500000, popGrowth5y: 1.6, employmentGrowth: 2.3, medianHHI: 79000, supplyPipeline: 3.4, rentGrowth: 2.8, trafficCount: 38000, marketCapRate: { carwash: 7.0, multifamily: 5.0, office: 7.6, retail: 6.4, industrial: 5.9 } },
];

/**
 * Midwest secondary and tertiary metros.
 *
 * Chosen for where $1.5M–$4M neighbourhood strip centres and 16–32 unit
 * apartment buildings actually trade. Before these existed, a deal in Columbus
 * resolved to no market at all and underwrote against DEFAULT_TAX_RATE — 1.50%,
 * against a Franklin County commercial effective rate of roughly 2%. An
 * estimate that is labelled an estimate beats a default that is labelled
 * nothing.
 */
const MIDWEST_MARKETS = [
  { key: 'columbus-oh',     city: 'Columbus',       state: 'OH', lat: 39.9612, lng: -82.9988, populationBasis: 'metro', effectiveTaxRate: 2.00, population: 2180000, popGrowth5y: 1.0, employmentGrowth: 1.5, medianHHI: 76000, supplyPipeline: 2.8, rentGrowth: 2.8, trafficCount: 34000, marketCapRate: { carwash: 7.8, multifamily: 5.8, office: 9.0, retail: 7.3, industrial: 6.6 } },
  { key: 'cincinnati-oh',   city: 'Cincinnati',     state: 'OH', lat: 39.1031, lng: -84.5120, populationBasis: 'metro', effectiveTaxRate: 2.05, population: 2270000, popGrowth5y: 0.5, employmentGrowth: 1.1, medianHHI: 73000, supplyPipeline: 2.2, rentGrowth: 2.6, trafficCount: 32000, marketCapRate: { carwash: 8.0, multifamily: 6.0, office: 9.4, retail: 7.6, industrial: 6.9 } },
  { key: 'cleveland-oh',    city: 'Cleveland',      state: 'OH', lat: 41.4993, lng: -81.6944, populationBasis: 'metro', effectiveTaxRate: 2.55, population: 2160000, popGrowth5y: -0.2, employmentGrowth: 0.5, medianHHI: 66000, supplyPipeline: 1.4, rentGrowth: 2.2, trafficCount: 30000, marketCapRate: { carwash: 8.5, multifamily: 6.6, office: 10.0, retail: 8.2, industrial: 7.4 } },
  { key: 'dayton-oh',       city: 'Dayton',         state: 'OH', lat: 39.7589, lng: -84.1916, populationBasis: 'metro', effectiveTaxRate: 2.25, population: 814000,  popGrowth5y: 0.0, employmentGrowth: 0.7, medianHHI: 65000, supplyPipeline: 1.2, rentGrowth: 2.1, trafficCount: 24000, marketCapRate: { carwash: 8.7, multifamily: 6.8, office: 10.3, retail: 8.4, industrial: 7.6 } },
  { key: 'indianapolis-in', city: 'Indianapolis',   state: 'IN', lat: 39.7684, lng: -86.1581, populationBasis: 'metro', effectiveTaxRate: 2.60, population: 2140000, popGrowth5y: 1.0, employmentGrowth: 1.4, medianHHI: 74000, supplyPipeline: 2.9, rentGrowth: 2.7, trafficCount: 33000, marketCapRate: { carwash: 7.9, multifamily: 5.9, office: 9.3, retail: 7.4, industrial: 6.5 } },
  { key: 'fort-wayne-in',   city: 'Fort Wayne',     state: 'IN', lat: 41.0793, lng: -85.1394, populationBasis: 'metro', effectiveTaxRate: 2.10, population: 430000,  popGrowth5y: 0.9, employmentGrowth: 1.2, medianHHI: 65000, supplyPipeline: 1.6, rentGrowth: 2.4, trafficCount: 23000, marketCapRate: { carwash: 8.6, multifamily: 6.7, office: 10.1, retail: 8.3, industrial: 7.5 } },
  { key: 'grand-rapids-mi', city: 'Grand Rapids',   state: 'MI', lat: 42.9634, lng: -85.6681, populationBasis: 'metro', effectiveTaxRate: 2.60, population: 1090000, popGrowth5y: 0.7, employmentGrowth: 1.2, medianHHI: 76000, supplyPipeline: 2.0, rentGrowth: 2.9, trafficCount: 28000, marketCapRate: { carwash: 8.1, multifamily: 6.1, office: 9.5, retail: 7.7, industrial: 6.8 } },
  { key: 'detroit-mi',      city: 'Detroit',        state: 'MI', lat: 42.3314, lng: -83.0458, populationBasis: 'metro', effectiveTaxRate: 3.40, population: 4340000, popGrowth5y: -0.2, employmentGrowth: 0.4, medianHHI: 72000, supplyPipeline: 1.3, rentGrowth: 2.0, trafficCount: 38000, marketCapRate: { carwash: 8.6, multifamily: 6.8, office: 10.2, retail: 8.4, industrial: 7.2 } },
  { key: 'chicago-il',      city: 'Chicago',        state: 'IL', lat: 41.8781, lng: -87.6298, populationBasis: 'metro', effectiveTaxRate: 3.70, population: 9260000, popGrowth5y: -0.3, employmentGrowth: 0.6, medianHHI: 84000, supplyPipeline: 2.4, rentGrowth: 2.5, trafficCount: 45000, marketCapRate: { carwash: 7.6, multifamily: 5.6, office: 9.5, retail: 7.2, industrial: 6.2 } },
  { key: 'kansas-city-mo',  city: 'Kansas City',    state: 'MO', lat: 39.0997, lng: -94.5786, populationBasis: 'metro', effectiveTaxRate: 2.30, population: 2220000, popGrowth5y: 0.7, employmentGrowth: 1.3, medianHHI: 79000, supplyPipeline: 2.6, rentGrowth: 2.7, trafficCount: 33000, marketCapRate: { carwash: 7.9, multifamily: 5.9, office: 9.2, retail: 7.4, industrial: 6.6 } },
  { key: 'st-louis-mo',     city: 'St. Louis',      state: 'MO', lat: 38.6270, lng: -90.1994, populationBasis: 'metro', effectiveTaxRate: 2.30, population: 2800000, popGrowth5y: 0.0, employmentGrowth: 0.7, medianHHI: 76000, supplyPipeline: 1.7, rentGrowth: 2.3, trafficCount: 31000, marketCapRate: { carwash: 8.3, multifamily: 6.3, office: 9.8, retail: 7.9, industrial: 7.0 } },
  { key: 'milwaukee-wi',    city: 'Milwaukee',      state: 'WI', lat: 43.0389, lng: -87.9065, populationBasis: 'metro', effectiveTaxRate: 2.60, population: 1560000, popGrowth5y: -0.1, employmentGrowth: 0.6, medianHHI: 72000, supplyPipeline: 1.8, rentGrowth: 2.4, trafficCount: 30000, marketCapRate: { carwash: 8.2, multifamily: 6.2, office: 9.7, retail: 7.8, industrial: 6.9 } },
  { key: 'madison-wi',      city: 'Madison',        state: 'WI', lat: 43.0731, lng: -89.4012, populationBasis: 'metro', effectiveTaxRate: 2.00, population: 690000,  popGrowth5y: 1.0, employmentGrowth: 1.4, medianHHI: 89000, supplyPipeline: 3.0, rentGrowth: 3.1, trafficCount: 26000, marketCapRate: { carwash: 7.7, multifamily: 5.5, office: 8.9, retail: 7.1, industrial: 6.4 } },
  { key: 'minneapolis-mn',  city: 'Minneapolis',    state: 'MN', lat: 44.9778, lng: -93.2650, populationBasis: 'metro', effectiveTaxRate: 3.20, population: 3700000, popGrowth5y: 0.4, employmentGrowth: 1.0, medianHHI: 92000, supplyPipeline: 2.5, rentGrowth: 2.5, trafficCount: 37000, marketCapRate: { carwash: 7.6, multifamily: 5.5, office: 8.8, retail: 7.0, industrial: 6.3 } },
  { key: 'des-moines-ia',   city: 'Des Moines',     state: 'IA', lat: 41.5868, lng: -93.6250, populationBasis: 'metro', effectiveTaxRate: 2.80, population: 745000,  popGrowth5y: 1.2, employmentGrowth: 1.6, medianHHI: 82000, supplyPipeline: 3.1, rentGrowth: 2.8, trafficCount: 27000, marketCapRate: { carwash: 8.0, multifamily: 6.0, office: 9.4, retail: 7.5, industrial: 6.7 } },
  { key: 'omaha-ne',        city: 'Omaha',          state: 'NE', lat: 41.2565, lng: -95.9345, populationBasis: 'metro', effectiveTaxRate: 2.05, population: 980000,  popGrowth5y: 0.8, employmentGrowth: 1.3, medianHHI: 78000, supplyPipeline: 2.3, rentGrowth: 2.6, trafficCount: 29000, marketCapRate: { carwash: 8.1, multifamily: 6.1, office: 9.5, retail: 7.6, industrial: 6.8 } },
];

export const markets = [
  ...SUNBELT_MARKETS.map((m) => buildRecord(m, SUNBELT_ESTIMATED)),
  ...MIDWEST_MARKETS.map((m) => buildRecord(m, MIDWEST_ESTIMATED)),
];

export const DEFAULT_TAX_RATE = 1.5;

const byKey = new Map(markets.map((m) => [m.key, m]));

/**
 * State-average COMMERCIAL effective rates, for a location that names a state
 * but no market this file carries.
 *
 * Every Midwest state the market list reaches into has an entry, because
 * without one a deal in, say, Toledo falls all the way to DEFAULT_TAX_RATE —
 * 1.50% against an Ohio commercial rate north of 2%, which is roughly a third
 * of the tax line missing from the NOI. A state average is a poor number; it is
 * a much better poor number than a national default.
 */
const stateFallbackTaxRate = {
  tx: 2.35, texas: 2.35,
  fl: 1.08, florida: 1.08,
  oh: 2.20, ohio: 2.20,
  in: 2.40, indiana: 2.40,
  mi: 2.80, michigan: 2.80,
  il: 3.00, illinois: 3.00,
  mo: 2.20, missouri: 2.20,
  wi: 2.30, wisconsin: 2.30,
  mn: 2.90, minnesota: 2.90,
  ia: 2.70, iowa: 2.70,
  ne: 2.00, nebraska: 2.00,
  ks: 2.40, kansas: 2.40,
};

/** Full names of the states above, for reading a state off a free-text location. */
const STATE_NAMES = {
  tx: 'texas', fl: 'florida', oh: 'ohio', in: 'indiana', mi: 'michigan',
  il: 'illinois', mo: 'missouri', wi: 'wisconsin', mn: 'minnesota',
  ia: 'iowa', ne: 'nebraska', ks: 'kansas',
};

/**
 * Periods are stripped as well as whitespace collapsed, so "St. Louis, MO" and
 * "St Louis, MO" resolve to the same market. They are the same place and a
 * broker writes it both ways in one email.
 */
function normalize(s) {
  return String(s || '').toLowerCase().trim().replace(/\./g, '').replace(/\s+/g, ' ');
}

/**
 * The state a free-text location names, as a lowercase code, or null.
 *
 * ANY trailing two-letter token counts, not just the states this file carries
 * markets in. That is the whole point: "Columbus, GA" has to be recognised as
 * naming Georgia so it can be REFUSED, and a list of only the known states
 * would read it as naming nothing and hand back Columbus, Ohio.
 */
export function statedState(location) {
  const q = normalize(location);
  const code = /(?:^|[,\s])([a-z]{2})$/.exec(q);
  if (code) return code[1];
  for (const [abbr, name] of Object.entries(STATE_NAMES)) {
    if (q === name || q.endsWith(`, ${name}`) || q.endsWith(` ${name}`)) return abbr;
  }
  return null;
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
  /**
   * Substring match, longest city name first so "north miami" doesn't beat
   * "miami" and "fort lauderdale" isn't shadowed by a shorter entry.
   *
   * A query that names a state only matches a market in THAT state. City names
   * repeat across the country and this list now holds several of the popular
   * ones: Columbus is in Ohio, Georgia and Indiana; Kansas City straddles two
   * states; Miami is in Florida and Oklahoma. Without the guard, "Columbus, GA"
   * silently underwrites against a Franklin County, Ohio tax rate — a wrong
   * answer that looks exactly like a right one.
   */
  const named = statedState(location);
  const ranked = [...markets].sort((a, b) => b.city.length - a.city.length);
  for (const m of ranked) {
    if (!q.includes(normalize(m.city))) continue;
    if (named && named !== normalize(m.state)) continue;
    return m;
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

/** Provenance for a rate that came from somewhere other than a market record. */
const fallbackProvenance = (dataQuality, source) => ({
  dataQuality,
  fields: { effectiveTaxRate: dataQuality },
  source,
  asOf: null,
});

/** Describes how a tax rate was resolved, so the UI can show confidence. */
export function resolveTaxRate(location) {
  const market = findMarket(location);
  if (market) {
    return { rate: market.effectiveTaxRate, basis: 'market', market, provenance: market.provenance };
  }
  const q = normalize(location);
  for (const [name, rate] of Object.entries(stateFallbackTaxRate)) {
    if (q === name || q.endsWith(`, ${name}`) || q.endsWith(` ${name}`)) {
      return {
        rate,
        basis: 'state',
        market: null,
        provenance: fallbackProvenance('estimate',
          'State-average commercial effective rate — no market record for this city'),
      };
    }
  }
  return {
    rate: DEFAULT_TAX_RATE,
    basis: 'default',
    market: null,
    // Not an estimate of anything. No market and no state matched, so this is a
    // placeholder standing where a number should be, and it says so.
    provenance: fallbackProvenance('seed',
      'No market or state matched this location; DEFAULT_TAX_RATE is a placeholder, not an estimate'),
  };
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
