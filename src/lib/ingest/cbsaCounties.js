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
const SERVICE_HINTS = [
  // Positive: names suggesting county-or-larger geography, current vintage.
  { pattern: /^tigerweb\//i, score: 2 },
  { pattern: /state.*county/i, score: 3 },
  { pattern: /cbsa|metropolitan|micropolitan/i, score: 3 },
  { pattern: /current/i, score: 2 },
  { pattern: /generalized/i, score: 1 },
  /**
   * Negative: a service pinned to one census is a snapshot of THAT census's
   * boundaries. Counties barely move, but CBSA delineations do — and the whole
   * point of this crosswalk is to use the LATEST county list. A year-stamped
   * service is a usable fallback, not a first choice.
   */
  { pattern: /census\s*\d{4}|acs\s*\d{4}|\b(19|20)\d{2}\b/i, score: -2 },
];

/** A ceiling on how many MapServers one discovery will open. */
export const MAX_SERVICES_PROBED = 30;

/**
 * How many features the right layer holds.
 *
 * The second thing the real run disproved: matching on name is not enough.
 * `Census2020/State_County` offers TWENTY-ONE layers all named exactly
 * "Counties" — TIGERweb stacks the same geography at several vintages and
 * generalisation tiers, and their names are identical. Nothing in the name, the
 * id or the order says which one carries whole counties at full detail.
 *
 * So the tie is broken by asking each candidate how many features it has, which
 * is a question only the right layer answers correctly. A US counties layer
 * holds about 3,143 — 3,235 with Puerto Rico's municipios and the island areas
 * — and a CBSA layer about 935 metro and micropolitan areas. The bands are wide
 * because the exact count moves with the vintage; they are narrow enough that
 * no other geography in these services falls inside one.
 */
export const EXPECTED_FEATURES = {
  counties: { min: 3000, max: 3400, about: 3143 },
  // Wide enough to accept either the combined layer (~935) or a metros-only
  // one (~393). The PATTERN does the work of excluding Micropolitan-only
  // (~542) and Combined Statistical Areas (~175); the band is the second lock,
  // not the first.
  cbsa: { min: 300, max: 1200, about: 935 },
};

/** A ceiling on how many candidate layers get a count probe. */
export const MAX_LAYERS_COUNTED = 25;

/**
 * How the two layers are recognised in the service's layer list.
 *
 * Matched by name rather than by id because TIGERweb renumbers layers between
 * vintages, and a stale id does not error — it returns a different geography
 * with the same field names, which is the worst kind of wrong.
 */
export const LAYER_PATTERNS = {
  /**
   * "Counties" exactly — not "County Subdivisions" (townships), and not
   * "Counties 500K" / "5M" / "20M", which are the same counties drawn for
   * small-scale maps. A generalised outline moves county borders by miles,
   * which is enough to put a centroid on the wrong side of a metro line.
   */
  counties: [/^counties$/i],

  /**
   * The CBSA layer, in preference order.
   *
   * The pattern here was `metropolitan statistical area/micropolitan
   * statistical area` — the name the ACS API uses for the geography — and no
   * TIGERweb layer is called that. The real names, from the probe:
   *
   *   Metropolitan and Micropolitan Statistical Areas   ← both, what we want
   *   Metropolitan Statistical Areas                    ← metros only
   *   Micropolitan Statistical Areas                    ← micros only
   *   Metropolitan Divisions, Combined Statistical Areas, and the New England
   *   City and Town Area family, none of which are CBSAs
   *
   * Anchored at both ends: `^metropolitan` excludes "Micropolitan" (which is a
   * real layer, would pass any feature-count band, and contains none of the
   * metros in this table), and `$` excludes every generalisation tier.
   */
  cbsa: [
    /^metropolitan and micropolitan statistical areas$/i,
    /^metropolitan statistical areas$/i,
  ],
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
  const counted = [];
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

    for (const [key, patterns] of Object.entries(LAYER_PATTERNS)) {
      if (found[key]) continue;
      // Patterns are tried in preference order: the combined CBSA layer before
      // a metros-only one. Label layers carry annotation geometry, not
      // boundaries, and never match.
      let hits = [];
      for (const pattern of patterns) {
        hits = layers.filter((l) => pattern.test(String(l.name || ''))
          && !/label/i.test(String(l.name || '')));
        if (hits.length) break;
      }
      if (!hits.length) continue;
      /**
       * Every candidate is count-verified, including a lone one.
       *
       * Skipping the check for a single hit was a hole: a service offering
       * exactly one layer called "Counties" that holds four hundred features
       * would have been accepted on its name alone. The name says what a layer
       * is meant to be; only the count says what it has.
       */
      const chosen = await chooseByFeatureCount(service.url, hits, EXPECTED_FEATURES[key], opts);
      if (!chosen) {
        counted.push(`${key} in ${service.name}: ${hits.length} candidates, none with a `
          + `plausible feature count`);
        continue;
      }
      found[key] = {
        id: chosen.id,
        name: chosen.name,
        service: service.url,
        features: chosen.count,
        // How many identically-named layers it was chosen from, so a probe
        // that picked one of twenty-one says so rather than looking decisive.
        pickedFrom: hits.length,
      };
    }
  }

  const missing = Object.keys(LAYER_PATTERNS).filter((k) => !found[k]);
  if (missing.length) {
    throw new CrosswalkError('layer_not_found',
      `no TIGERweb layer for ${missing.join(' or ')} in ${searched.length} services `
      + `(${searched.join(', ')}). `
      + (counted.length ? `Count probes: ${counted.join('; ')}. ` : '')
      + `Layers seen: ${[...offered].slice(0, 60).join(', ')}`,
      { missing, searched, counted, offered: [...offered] });
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

  const score = (name) => SERVICE_HINTS
    .reduce((total, h) => total + (h.pattern.test(name) ? h.score : 0), 0);
  return services
    .filter((svc) => String(svc.type || 'MapServer') === 'MapServer')
    .map((svc) => ({
      name: svc.name,
      url: `${TIGERWEB_ROOT}/${svc.name}/MapServer`,
      score: score(svc.name),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * Pick between identically-named layers by how many features each holds.
 *
 * `Census2020/State_County` offers twenty-one layers called "Counties". Their
 * names, ids and order say nothing about which one carries whole counties at
 * full detail, so the only honest discriminator is the data itself: a counties
 * layer has about 3,143 rows and a scale-generalised or partial one does not.
 *
 * `returnCountOnly` makes each probe a few bytes, and candidates are tried in
 * id order and the FIRST plausible one wins — so the usual case is one extra
 * request, not twenty-one.
 */
export async function chooseByFeatureCount(serviceUrl, candidates, expected, opts = {}) {
  if (!expected) return candidates[0] ? { ...candidates[0], count: null } : null;

  const ordered = [...candidates].sort((a, b) => a.id - b.id).slice(0, MAX_LAYERS_COUNTED);
  for (const layer of ordered) {
    let count;
    try {
      const body = await getJson(
        `${serviceUrl}/${layer.id}/query?where=1%3D1&returnCountOnly=true&f=json`, opts,
      );
      count = body?.count;
    } catch {
      // A layer that will not answer a count is a layer that will not answer a
      // spatial query either.
      continue;
    }
    if (typeof count !== 'number') continue;
    if (count >= expected.min && count <= expected.max) return { ...layer, count };
  }
  return null;
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
