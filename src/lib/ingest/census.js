/**
 * Census: how many people live within three miles, and whether that is rising.
 *
 * Free, no key, nationwide. Three calls:
 *
 *   1. Geocoder        address → lat/lng, state and county FIPS
 *   2. TIGERweb        tracts whose centroid is within the radius
 *   3. ACS 5-year      population for those tracts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GROWTH PROBLEM, which is real and is not a limitation of this code
 *
 * "Three-mile population growth over five years" is a standard retail metric
 * and it is currently NOT cleanly computable at tract level. Two independent
 * reasons:
 *
 *   BOUNDARIES. ACS 5-year products through 2020 are published on 2010 census
 *   tracts; from 2021 they are on 2020 tracts. Differencing a 2019 estimate
 *   against a 2023 one for "the same tract" compares two different pieces of
 *   ground, and in a growing suburb the tracts that changed most are exactly
 *   the ones that were split because they grew.
 *
 *   OVERLAP. The Census Bureau says plainly not to compare overlapping 5-year
 *   estimates. 2019 (2015-2019) against 2023 (2019-2023) shares a year; the
 *   nearest non-overlapping pair on 2020 boundaries needs the 2026 release.
 *
 * So this returns the LEVEL at tract resolution, which is solid, and the GROWTH
 * at county resolution, where boundaries are stable and non-overlapping
 * vintages exist — with `popGrowthBasis: 'county'` on the result and the county
 * named in the provenance. A county is not three miles and the report says so
 * rather than letting a county number wear a three-mile label.
 *
 * If you want true three-mile growth, the honest route is the Census tract
 * relationship files to crosswalk 2010 tracts onto 2020 ones. That is a real
 * piece of work and it is not this.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NOTHING HERE HAS MADE A LIVE CALL. See src/lib/ingest/http.js.
 */

import { getJson, haversineMiles } from './http.js';
import { censusKeyParam } from './acsMarkets.js';

const GEOCODER = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const TIGERWEB = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/6/query';
const ACS = 'https://api.census.gov/data';

/** Total population. The one ACS variable this module needs. */
const POP = 'B01003_001E';

/**
 * Which ACS vintages to difference for county growth.
 *
 * Non-overlapping by construction: 2013-2017 against 2018-2022 share no year.
 * Both are on stable county boundaries, so the comparison means what it says.
 * Overridable, and `assertNonOverlapping` refuses a pair that is not.
 */
export const DEFAULT_VINTAGES = { from: 2017, to: 2022 };

/** 5-year estimates labelled YYYY cover YYYY-4 … YYYY. */
export function assertNonOverlapping({ from, to }) {
  if (!(to > from)) throw new Error(`vintages must increase; got ${from} → ${to}`);
  if (to - from < 5) {
    throw new Error(
      `ACS 5-year estimates ${from} (${from - 4}-${from}) and ${to} (${to - 4}-${to}) overlap. `
      + 'The Census Bureau advises against differencing overlapping 5-year estimates; '
      + 'use vintages at least 5 apart.',
    );
  }
}

/**
 * Address → a point and its county.
 *
 * The geocoder returns candidates; the first is taken and its match score is
 * carried through, because a 3-mile ring drawn around the wrong side of town
 * produces a confident and wrong demographic profile.
 */
export async function geocode(address, opts = {}) {
  const url = `${GEOCODER}?address=${encodeURIComponent(address)}`
    + '&benchmark=Public_AR_Current&format=json';
  const body = await getJson(url, opts);
  const match = body?.result?.addressMatches?.[0];
  if (!match) return null;
  return {
    lat: match.coordinates.y,
    lng: match.coordinates.x,
    matchedAddress: match.matchedAddress,
    state: match.geographies?.['Census Blocks']?.[0]?.STATE
      || match.addressComponents?.state || null,
    county: match.geographies?.['Census Blocks']?.[0]?.COUNTY || null,
  };
}

/**
 * Tract GEOIDs whose CENTROID lies within `radiusMiles` of the point.
 *
 * The spatial query asks for tracts that INTERSECT the ring, then the centroid
 * filter narrows them. Intersection alone over-includes: one large rural tract
 * clipping the edge of the circle would contribute its whole population, which
 * on a 3-mile ring can be most of the answer.
 *
 * The centroid method has its own known bias — a tract is in or out whole — and
 * that is the conventional trade for not doing area-weighted overlap. It is
 * recorded on the result rather than left implicit.
 */
export async function tractsWithin({ lat, lng }, radiusMiles = 3, opts = {}) {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    distance: String(radiusMiles),
    units: 'esriSRUnit_StatuteMile',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'GEOID,CENTLAT,CENTLON,STATE,COUNTY,TRACT',
    returnGeometry: 'false',
    f: 'json',
  });
  const body = await getJson(`${TIGERWEB}?${params}`, opts);
  const features = body?.features || [];

  const inside = [];
  let clipped = 0;
  for (const f of features) {
    const a = f.attributes || {};
    const centroid = { lat: Number(a.CENTLAT), lng: Number(a.CENTLON) };
    if (!Number.isFinite(centroid.lat) || !Number.isFinite(centroid.lng)) continue;
    if (haversineMiles({ lat, lng }, centroid) <= radiusMiles) {
      inside.push({
        geoid: a.GEOID, state: a.STATE, county: a.COUNTY, tract: a.TRACT,
      });
    } else clipped += 1;
  }
  return { tracts: inside, intersectingButExcluded: clipped, method: 'centroid-in-radius' };
}

/** Population for every tract in a county, keyed by GEOID. */
export async function tractPopulations({ state, county, vintage }, opts = {}) {
  // The ACS endpoints need a key; the geocoder and TIGERweb do not. See
  // censusKeyParam — a keyless call comes back as HTML with a 200.
  const url = `${ACS}/${vintage}/acs/acs5?get=${POP}&for=tract:*`
    + `&in=state:${state}%20county:${county}${censusKeyParam(opts.apiKey)}`;
  const rows = await getJson(url, opts);
  // ACS answers as a header row followed by data rows, not as objects.
  const [header, ...data] = rows;
  const iPop = header.indexOf(POP);
  const iState = header.indexOf('state');
  const iCounty = header.indexOf('county');
  const iTract = header.indexOf('tract');
  const out = new Map();
  for (const r of data) {
    const pop = Number(r[iPop]);
    // ACS uses large negative sentinels for suppressed values. Reading -666666666
    // as a population is how a neighbourhood ends up with negative people.
    out.set(`${r[iState]}${r[iCounty]}${r[iTract]}`, pop < 0 ? null : pop);
  }
  return out;
}

/** County population for one vintage. */
export async function countyPopulation({ state, county, vintage }, opts = {}) {
  const url = `${ACS}/${vintage}/acs/acs5?get=NAME,${POP}`
    + `&for=county:${county}&in=state:${state}${censusKeyParam(opts.apiKey)}`;
  const rows = await getJson(url, opts);
  const [header, row] = rows;
  if (!row) return null;
  const pop = Number(row[header.indexOf(POP)]);
  return { name: row[header.indexOf('NAME')], population: pop < 0 ? null : pop };
}

/**
 * Everything, for one address.
 *
 * Returns `null` fields rather than throwing when a step yields nothing, so a
 * property whose address the geocoder cannot match still enriches whatever it
 * can and reports the rest as unknown.
 */
export async function enrichDemographics(address, {
  radiusMiles = 3, vintages = DEFAULT_VINTAGES, latestVintage = 2023, ...opts
} = {}) {
  assertNonOverlapping(vintages);

  const point = await geocode(address, opts);
  if (!point) {
    return { fields: {}, notes: [`Census geocoder found no match for ${JSON.stringify(address)}`] };
  }
  const notes = [];

  // ── Level, at tract resolution ───────────────────────────────────────────
  const { tracts, intersectingButExcluded, method } = await tractsWithin(point, radiusMiles, opts);
  let pop = null;
  let suppressed = 0;
  if (tracts.length) {
    // Tracts can span counties near a boundary, so the ACS calls are grouped.
    const counties = [...new Set(tracts.map((t) => `${t.state}|${t.county}`))];
    const byGeoid = new Map();
    for (const key of counties) {
      const [state, county] = key.split('|');
      const popByTract = await tractPopulations({ state, county, vintage: latestVintage }, opts);
      for (const [geoid, value] of popByTract) byGeoid.set(geoid, value);
    }
    pop = 0;
    for (const t of tracts) {
      const value = byGeoid.get(t.geoid);
      if (value === null || value === undefined) { suppressed += 1; continue; }
      pop += value;
    }
    if (suppressed) {
      notes.push(`${suppressed} of ${tracts.length} tracts had no usable population figure; `
        + 'the total is the remainder and understates the ring.');
    }
  } else {
    notes.push('no census tracts resolved within the radius');
  }

  // ── Growth, at county resolution. See the note at the top of this file ───
  let growthPct = null;
  let countyName = null;
  if (point.state && point.county) {
    const [before, after] = await Promise.all([
      countyPopulation({ state: point.state, county: point.county, vintage: vintages.from }, opts),
      countyPopulation({ state: point.state, county: point.county, vintage: vintages.to }, opts),
    ]);
    if (before?.population && after?.population) {
      growthPct = ((after.population / before.population) - 1) * 100;
      countyName = after.name;
      notes.push(
        `Population growth is COUNTY-level (${countyName}), not 3-mile: ACS tract boundaries `
        + `changed between the 2010 and 2020 censuses, so a tract-level 5-year comparison is `
        + `not like-for-like. Vintages ${vintages.from} and ${vintages.to}, non-overlapping.`,
      );
    }
  }

  return {
    point,
    fields: {
      [`pop${radiusMiles}mi`]: pop,
      popGrowth3mi: growthPct,
      popGrowthBasis: growthPct === null ? null : 'county',
    },
    detail: {
      tractCount: tracts.length,
      tractMethod: method,
      intersectingButExcluded,
      suppressedTracts: suppressed,
      countyName,
      vintages,
      latestVintage,
    },
    notes,
  };
}
