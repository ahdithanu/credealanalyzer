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

const TIGERWEB_ROOT = 'https://tigerweb.geo.census.gov/arcgis/rest/services';

/**
 * TIGERweb is many MapServers, not one, and they are split by geography SIZE.
 *
 * The first version of this looked only in `TIGERweb/tigerWMS_Current`, which
 * was a guess that the probe disproved on the first real run: that service
 * carries tracts, blocks, places and County SUBDIVISIONS — every geography
 * below a county — and neither Counties nor CBSAs. The error printed the
 * layers it was offered, which is how we know.
 *
 * So the search now spans services. The two layers may live in different ones,
 * and which service holds what has already moved once, so nothing here names a
 * service either — the REST directory is listed and every candidate is opened
 * until both layers are found.
 */
const SERVICE_PRIORITY = [
  // Opened first because their names suggest county-or-larger geography. Being
  // wrong about this order costs a few requests, not a wrong answer.
  /state.*county/i,
  /cbsa|metropolitan|micropolitan/i,
  /generalized/i,
  /current/i,
];

/** A ceiling on how many MapServers one discovery will open. */
export const MAX_SERVICES_PROBED = 30;

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
  const services = await listServices(opts);
  if (!services.length) {
    throw new CrosswalkError('no_services',
      `${TIGERWEB_ROOT} listed no MapServers; the directory may have moved`);
  }

  const found = {};
  const searched = [];
  const offered = new Set();

  for (const service of services) {
    if (searched.length >= MAX_SERVICES_PROBED) break;
    if (Object.keys(found).length === Object.keys(LAYER_PATTERNS).length) break;

    let layers;
    try {
      const body = await getJson(`${service.url}?f=json`, opts);
      layers = [...(body?.layers || []), ...(body?.tables || [])];
    } catch {
      // One unreachable service must not end the search; the next may hold
      // both layers.
      continue;
    }
    searched.push(service.name);
    for (const l of layers) offered.add(String(l.name || ''));

    for (const [key, pattern] of Object.entries(LAYER_PATTERNS)) {
      if (found[key]) continue;
      // Label layers carry annotation geometry, not boundaries.
      const hits = layers.filter((l) => pattern.test(String(l.name || ''))
        && !/label/i.test(String(l.name || '')));
      if (!hits.length) continue;
      if (hits.length > 1) {
        throw new CrosswalkError('layer_ambiguous',
          `${hits.length} layers in ${service.name} match ${key}: `
          + `${hits.map((l) => `${l.id}=${l.name}`).join(', ')}`,
          { layer: key, service: service.name, candidates: hits });
      }
      found[key] = { id: hits[0].id, name: hits[0].name, service: service.url };
    }
  }

  const missing = Object.keys(LAYER_PATTERNS).filter((k) => !found[k]);
  if (missing.length) {
    throw new CrosswalkError('layer_not_found',
      `no TIGERweb layer for ${missing.join(' or ')} in ${searched.length} services `
      + `(${searched.join(', ')}). Layers seen: ${[...offered].slice(0, 60).join(', ')}`,
      { missing, searched, offered: [...offered] });
  }
  return found;
}

/**
 * Every MapServer the TIGERweb directory lists, best candidates first.
 *
 * The directory is read rather than hardcoded for the same reason the layer ids
 * are: it has already changed once under this code.
 */
export async function listServices(opts = {}) {
  const body = await getJson(`${TIGERWEB_ROOT}?f=json`, opts);
  const folders = body?.folders || [];
  const services = [...(body?.services || [])];

  // Services live inside folders as well as at the root, and TIGERweb keeps
  // almost everything in a folder of its own name.
  for (const folder of folders) {
    try {
      const sub = await getJson(`${TIGERWEB_ROOT}/${folder}?f=json`, opts);
      services.push(...(sub?.services || []));
    } catch {
      continue;
    }
  }

  const rank = (name) => {
    const i = SERVICE_PRIORITY.findIndex((p) => p.test(name));
    return i === -1 ? SERVICE_PRIORITY.length : i;
  };
  return services
    .filter((svc) => String(svc.type || 'MapServer') === 'MapServer')
    .map((svc) => ({ name: svc.name, url: `${TIGERWEB_ROOT}/${svc.name}/MapServer` }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
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
  const cbsaBody = await getJson(`${bound.cbsa.service}/${bound.cbsa.id}/query?${cbsaParams}`, opts);
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
  const countyBody = await getJson(`${bound.counties.service}/${bound.counties.id}/query?${countyParams}`, opts);
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
