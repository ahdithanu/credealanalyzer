/**
 * Which counties make up a metro — discovered, not assumed.
 *
 * This exists so `popGrowth5y` can be computed over a FIXED set of counties
 * rather than by differencing two CBSA populations. OMB revises CBSA
 * delineations between ACS vintages, so the naive difference measures the
 * boundary as much as the people: on the first real run Gainesville "grew"
 * 23.1% in five years because Levy and Gilchrist counties joined it, and
 * Corpus Christi "shrank" 6.2% because Aransas left.
 *
 * County boundaries are stable, and a CBSA is a union of WHOLE counties. So:
 * take the county list from the latest delineation, then sum county populations
 * over that same list in both years. The comparison then means what it says.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERYTHING HERE IS DISCOVERED AT RUNTIME, ON PURPOSE
 *
 * The county list is not in the ACS API — CBSA is its own summary level, not a
 * rung on the state/county hierarchy — and OMB publishes the delineation as a
 * spreadsheet, which is not a thing to parse in a browser bundle.
 *
 * So it comes from TIGERweb, spatially: a CBSA polygon contains exactly its
 * member counties, because it is built out of them. No crosswalk file, no
 * hardcoded list, nothing to go stale.
 *
 * The layer IDs are the one thing that could be wrong, and TIGERweb renumbers
 * them between releases — so they are NOT hardcoded either. `discoverLayers`
 * reads the service's own layer list and matches by name. Nothing in this file
 * was written against a live endpoint (the environment it was written in
 * cannot reach census.gov), and `npm run markets -- --probe-counties` is how
 * you confirm it before trusting a number out of it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getJson } from './http.js';

const TIGERWEB_SERVICE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';

/**
 * How the two layers are recognised in the service's layer list.
 *
 * Matched by name rather than by id because TIGERweb renumbers layers between
 * vintages, and a stale id does not error — it returns a different geography
 * with the same field names, which is the worst kind of wrong.
 */
export const LAYER_PATTERNS = {
  // "Counties" — and not "County Subdivisions", which is a different thing
  // that would match a looser pattern and silently return townships.
  counties: /^counties$/i,
  cbsa: /metropolitan statistical area\/micropolitan statistical area/i,
};

/** Fields to read off a county. CENTLAT/CENTLON decide membership. */
const COUNTY_FIELDS = 'GEOID,STATE,COUNTY,NAME,BASENAME,CENTLAT,CENTLON';

export class CrosswalkError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.code = code;
    Object.assign(this, context);
  }
}

/**
 * Read the service's layer list and find the two layers by name.
 *
 * Returns their ids and the names they matched, so a run can print what it
 * actually bound to rather than asserting it bound to the right thing.
 */
export async function discoverLayers(opts = {}) {
  const body = await getJson(`${TIGERWEB_SERVICE}?f=json`, opts);
  const layers = [...(body?.layers || []), ...(body?.tables || [])];
  if (!layers.length) {
    throw new CrosswalkError('no_layers',
      `${TIGERWEB_SERVICE} answered without a layer list; the service may have moved`);
  }

  const found = {};
  for (const [key, pattern] of Object.entries(LAYER_PATTERNS)) {
    const hits = layers.filter((l) => pattern.test(String(l.name || '')));
    if (!hits.length) {
      throw new CrosswalkError('layer_not_found',
        `no TIGERweb layer matching ${key} (${pattern}). Layers offered: `
        + `${layers.map((l) => l.name).slice(0, 40).join(', ')}`,
        { layer: key, offered: layers.map((l) => l.name) });
    }
    /**
     * More than one match is not resolvable by guessing. TIGERweb carries
     * "Metropolitan Statistical Area/Micropolitan Statistical Area" and
     * "...Labels" as separate layers, and picking the wrong one returns
     * annotation geometry, so an ambiguous match is reported rather than
     * resolved by taking the first.
     */
    const exact = hits.filter((l) => !/label/i.test(String(l.name)));
    if (exact.length !== 1) {
      throw new CrosswalkError('layer_ambiguous',
        `${exact.length} TIGERweb layers match ${key}: ${hits.map((l) => `${l.id}=${l.name}`).join(', ')}`,
        { layer: key, candidates: hits });
    }
    found[key] = { id: exact[0].id, name: exact[0].name };
  }
  return found;
}

/**
 * The counties a CBSA is made of.
 *
 * Two queries: fetch the CBSA's geometry by GEOID, then fetch counties that
 * intersect it. Membership is decided by CENTROID, which for this geography is
 * exact rather than approximate — a CBSA is a union of whole counties, so a
 * county is either wholly in or wholly out, and the centroid test only has to
 * separate members from neighbours sharing a border.
 */
export async function countiesInCbsa(cbsaGeoid, { layers, ...opts } = {}) {
  const bound = layers || await discoverLayers(opts);

  const cbsaParams = new URLSearchParams({
    where: `GEOID='${cbsaGeoid}'`,
    outFields: 'GEOID,NAME',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  });
  const cbsaBody = await getJson(`${TIGERWEB_SERVICE}/${bound.cbsa.id}/query?${cbsaParams}`, opts);
  const cbsaFeature = cbsaBody?.features?.[0];
  if (!cbsaFeature?.geometry) {
    throw new CrosswalkError('cbsa_not_found',
      `TIGERweb has no CBSA with GEOID ${cbsaGeoid} in ${bound.cbsa.name}`,
      { cbsa: cbsaGeoid });
  }

  const countyParams = new URLSearchParams({
    geometry: JSON.stringify(cbsaFeature.geometry),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: COUNTY_FIELDS,
    returnGeometry: 'false',
    f: 'json',
  });
  const countyBody = await getJson(`${TIGERWEB_SERVICE}/${bound.counties.id}/query?${countyParams}`, opts);
  const features = countyBody?.features || [];
  if (!features.length) {
    throw new CrosswalkError('no_counties',
      `no counties intersect CBSA ${cbsaGeoid}; the layer binding is probably wrong`,
      { cbsa: cbsaGeoid, layers: bound });
  }

  /**
   * Intersection over-selects: a county that merely shares a border with the
   * metro comes back too. The centroid test removes those, and the count of
   * what it removed is returned rather than discarded — a metro where the
   * filter dropped nothing is a metro where the spatial query behaved
   * differently from expected, and that is worth being able to see.
   */
  const inside = [];
  const touchingOnly = [];
  for (const f of features) {
    const a = f.attributes || {};
    const lat = Number(a.CENTLAT);
    const lng = Number(a.CENTLON);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const row = {
      geoid: a.GEOID,
      state: a.STATE,
      county: a.COUNTY,
      name: a.BASENAME || a.NAME,
      lat,
      lng,
    };
    if (pointInRings(lng, lat, cbsaFeature.geometry.rings || [])) inside.push(row);
    else touchingOnly.push(row);
  }

  if (!inside.length) {
    throw new CrosswalkError('no_counties_inside',
      `${features.length} counties intersect CBSA ${cbsaGeoid} but none has its centroid inside; `
      + 'the CBSA geometry or the centroid fields are not what this expects',
      { cbsa: cbsaGeoid });
  }

  return {
    cbsa: cbsaGeoid,
    cbsaName: cbsaFeature.attributes?.NAME ?? null,
    counties: inside.sort((a, b) => a.geoid.localeCompare(b.geoid)),
    bordering: touchingOnly.length,
    layers: bound,
  };
}

/**
 * Even-odd ray casting over an Esri polygon's rings.
 *
 * Esri encodes holes as clockwise rings, and even-odd handles them for free:
 * a point inside a hole crosses an even number of edges overall and reads as
 * outside. A county centroid inside a metro's hole is not a case that arises,
 * but getting it right costs nothing and getting it wrong would be invisible.
 */
export function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      // Strictly one endpoint above and one at-or-below, so a vertex lying on
      // the ray is counted once rather than twice.
      const straddles = (yi > y) !== (yj > y);
      if (!straddles) continue;
      const xCross = xi + ((y - yi) / (yj - yi)) * (xj - xi);
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}
