/**
 * Sourced overrides for the market table. GENERATED — do not hand-edit.
 *
 * Written by `npm run markets -- --write`, which reads Census ACS 5-year
 * estimates at CBSA level. Empty means the script has never been run against a
 * reachable api.census.gov, and every field in src/lib/markets.js is still seed
 * or estimate data.
 *
 * Each entry is:
 *
 *   'columbus-oh': {
 *     cbsa: '18140',
 *     cbsaName: 'Columbus, OH Metro Area',   // the Census's own name — CHECK IT
 *     asOf: 'ACS 5-year 2022',
 *     fields: { population: 2151017, medianHHI: 76208, popGrowth5y: 0.94,
 *               populationBasis: 'metro' },
 *   }
 *
 * Only the fields present here are marked 'sourced'. Everything else keeps the
 * quality it had, and the record's `dataQuality` stays at its weakest field —
 * so a sourced population does not turn an invented cap rate into a fact.
 */

export const SOURCED = {};
