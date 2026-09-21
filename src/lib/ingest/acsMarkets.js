/**
 * Sourcing the market table's demographics from the Census.
 *
 * `src/lib/markets.js` carries thirty-six records whose every field is seed or
 * estimate data. Four of the nine fields have a free, keyless, nationwide
 * source and this is it: ACS 5-year estimates at CBSA (metro) level give
 * population and median household income directly, and a five-year population
 * CAGR by differencing two non-overlapping vintages.
 *
 * The other five — employment growth, supply pipeline, rent growth, traffic
 * count and market cap rates — have no free equivalent. Employment growth is
 * BLS CES and could be added; supply pipeline, rent growth and cap rates are
 * CoStar, Yardi and the broker cap rate surveys, and there is no public
 * substitute for any of them. So `dataQuality` on these records stays 'seed'
 * even after this has run, because it reports the WEAKEST field. That is the
 * design working, not a bug to route around.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CBSA CODES BELOW ARE UNVERIFIED, AND THE SCRIPT CHECKS THEM FOR YOU
 *
 * api.census.gov was not reachable from the environment this was written in —
 * the egress allowlist refuses it — so not one of these codes has been called.
 * A wrong code does not error: it returns a real metro area, just not yours.
 *
 * Which is why every result carries `cbsaName`, the name the Census itself
 * returned, and `npm run markets` prints it beside the city the record claims
 * to be. A transposed code shows up as "Columbus, GA Metro Area" next to
 * Columbus, OH, which takes a second to see and is impossible to see any other
 * way.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getJson } from './http.js';
import { assertNonOverlapping } from './census.js';

const ACS = 'https://api.census.gov/data';
const POP = 'B01003_001E';
const MEDIAN_HHI = 'B19013_001E';
const CBSA_GEO = 'metropolitan statistical area/micropolitan statistical area';

/**
 * Market key → CBSA code. Unverified; see the header.
 *
 * Several records share a code because they share a metro: Plano, Arlington,
 * Irving and Fort Worth are all Dallas–Fort Worth, and Fort Lauderdale and West
 * Palm Beach are both the Miami CBSA. Sourcing those replaces a CITY population
 * with the METRO one, which is what the field is documented to hold — and makes
 * marketScore's Market Scale feature identical across every submarket of one
 * metro. That is arguably right, since exit liquidity is a metro property, but
 * it is a change in meaning and `npm run markets` will not write it without
 * --write.
 */
export const CBSA = {
  'houston-tx': '26420',
  'dallas-tx': '19100',
  'austin-tx': '12420',
  'san-antonio-tx': '41700',
  'fort-worth-tx': '19100',
  'plano-tx': '19100',
  'arlington-tx': '19100',
  'corpus-christi-tx': '18580',
  'lubbock-tx': '31180',
  'irving-tx': '19100',
  'miami-fl': '33100',
  'orlando-fl': '36740',
  'tampa-fl': '45300',
  'jacksonville-fl': '27260',
  'fort-lauderdale-fl': '33100',
  'tallahassee-fl': '45220',
  'gainesville-fl': '23540',
  'pensacola-fl': '37860',
  'clearwater-fl': '45300',
  'west-palm-beach-fl': '33100',
  'columbus-oh': '18140',
  'cincinnati-oh': '17140',
  'cleveland-oh': '17460',
  'dayton-oh': '19430',
  'indianapolis-in': '26900',
  'fort-wayne-in': '23060',
  'grand-rapids-mi': '24340',
  'detroit-mi': '19820',
  'chicago-il': '16980',
  'kansas-city-mo': '28140',
  'st-louis-mo': '41180',
  'milwaukee-wi': '33340',
  'madison-wi': '31540',
  'minneapolis-mn': '33460',
  'des-moines-ia': '19780',
  'omaha-ne': '36540',
};

/**
 * Which vintages to difference for five-year growth.
 *
 * 2013–2017 against 2018–2022: five years apart and sharing no year, which is
 * what the Census Bureau asks for. `assertNonOverlapping` enforces it.
 */
export const DEFAULT_VINTAGES = { from: 2017, to: 2022 };

/** ACS uses large negative sentinels for suppressed values, not nulls. */
function acsNumber(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * One vintage's figures for one CBSA.
 *
 * ACS answers as a header row followed by data rows, not as objects, and the
 * column order is not guaranteed to match the order requested — so the columns
 * are located by name.
 */
export async function cbsaFigures(cbsa, { vintage, variables = [POP, MEDIAN_HHI] }, opts = {}) {
  // Spaces are encoded, the slash is NOT. The Census's own documented form for
  // this geography is `metropolitan%20statistical%20area/micropolitan%20...`,
  // and encodeURIComponent would turn the separator into %2F.
  const geo = CBSA_GEO.split('/').map(encodeURIComponent).join('/');
  const url = `${ACS}/${vintage}/acs/acs5?get=NAME,${variables.join(',')}&for=${geo}:${cbsa}`;
  const rows = await getJson(url, opts);
  const [header, row] = rows || [];
  if (!header || !row) return null;

  const at = (name) => {
    const i = header.indexOf(name);
    return i < 0 ? null : row[i];
  };
  const out = { cbsa, name: at('NAME') };
  for (const v of variables) out[v] = acsNumber(at(v));
  return out;
}

/**
 * Everything sourceable for one market.
 *
 * Returns `fields` in the market record's own vocabulary, so the caller merges
 * rather than translates, plus the Census's own name for the CBSA — which is
 * the only check on the code being the right one.
 */
export async function sourceMarket(key, {
  cbsa = CBSA[key],
  vintages = DEFAULT_VINTAGES,
  latestVintage = vintages.to,
  ...opts
} = {}) {
  if (!cbsa) {
    return { key, fields: {}, notes: [`no CBSA code registered for ${key}`] };
  }
  assertNonOverlapping(vintages);

  const notes = [];
  const latest = await cbsaFigures(cbsa, { vintage: latestVintage }, opts);
  if (!latest) {
    return { key, cbsa, fields: {}, notes: [`ACS ${latestVintage} returned no row for CBSA ${cbsa}`] };
  }

  const fields = {};
  if (latest[POP] !== null) {
    fields.population = latest[POP];
    // The field is documented as metro population and this one genuinely is,
    // which for the six submarket records is a change of basis, not a refresh.
    fields.populationBasis = 'metro';
  } else {
    notes.push(`ACS ${latestVintage} suppressed population for CBSA ${cbsa}`);
  }
  if (latest[MEDIAN_HHI] !== null) fields.medianHHI = latest[MEDIAN_HHI];
  else notes.push(`ACS ${latestVintage} suppressed median household income for CBSA ${cbsa}`);

  // Growth, as a CAGR over the gap between the two vintages' labels.
  const earlier = await cbsaFigures(cbsa, { vintage: vintages.from, variables: [POP] }, opts);
  if (earlier?.[POP] && latest[POP]) {
    const years = vintages.to - vintages.from;
    fields.popGrowth5y = (((latest[POP] / earlier[POP]) ** (1 / years)) - 1) * 100;
  } else {
    notes.push(`no ${vintages.from} population for CBSA ${cbsa}; growth not computed`);
  }

  return {
    key,
    cbsa,
    cbsaName: latest.name,
    fields,
    detail: { vintages, latestVintage, earlier: earlier?.[POP] ?? null, latest: latest[POP] },
    notes,
  };
}

/** Which market fields this module can actually fill. Everything else stays seed. */
export const SOURCEABLE_FIELDS = ['population', 'medianHHI', 'popGrowth5y'];

/**
 * Render the generated overlay module.
 *
 * Extracted from the script so the write path can be tested: a generated file
 * that does not parse breaks the whole app at import time, and the script that
 * writes it cannot run here to find out. `JSON.stringify` output is valid JS
 * object-literal syntax for these values, which is why the entries go through
 * it rather than through hand-built template strings.
 */
export function renderSourcedModule(entries, { vintages = DEFAULT_VINTAGES, writtenOn } = {}) {
  const day = writtenOn || new Date().toISOString().slice(0, 10);
  return `/**
 * Sourced overrides for the market table. GENERATED — do not hand-edit.
 *
 * Written by \`npm run markets -- --write\`. Re-run it to refresh; edit
 * src/lib/markets.js for anything this does not cover.
 *
 * Source: Census ACS 5-year estimates at CBSA level.
 * Vintages: ${vintages.from} and ${vintages.to} (non-overlapping).
 * Written: ${day}
 */

export const SOURCED = ${JSON.stringify(entries, null, 2)};
`;
}
