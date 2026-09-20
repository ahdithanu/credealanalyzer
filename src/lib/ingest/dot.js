/**
 * Traffic counts, from state departments of transportation.
 *
 * Your buy box wants 15,000–25,000+ vehicles per day, and the number on a
 * broker's flyer is marketing. State DOTs publish measured annual average daily
 * traffic as ArcGIS feature services, free and without a key. There is no
 * national endpoint — every state runs its own — so this is a registry plus one
 * spatial query.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE TRUSTING A NUMBER OUT OF HERE
 *
 * EVERY URL BELOW IS UNVERIFIED. They could not be called from the environment
 * this was written in, and state DOT service URLs move — a reorganisation
 * renames a folder and the endpoint 404s, or worse, answers a redirect page
 * with HTTP 200. So:
 *
 *   - Each entry carries `verified: false` and every enrichment that uses one
 *     emits a note saying so. Nothing here quietly presents a guess as a fact.
 *   - `probe()` calls an endpoint and reports its actual field names, which is
 *     how you confirm a URL and map its columns in one step.
 *   - Adding a state is three lines. Correcting one is one line.
 *
 * The field names are the other half of the problem: one state calls it AADT,
 * the next ADT, the next CURRENT_AADT, and the year is sometimes in the field
 * name rather than a column. `aadtFields` is a list of candidates tried in
 * order, so a near-miss still works.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getJson, haversineMiles, MILES_TO_M } from './http.js';

/**
 * Candidate endpoints.
 *
 * Starting points to probe, not facts. `verified` stays false until you have
 * run `npm run enrich -- --probe=OH` and seen real fields come back; set it in
 * your own config rather than editing this file, so an upstream change to this
 * list cannot silently re-mark something as checked.
 */
export const DOT_SOURCES = {
  OH: {
    name: 'Ohio DOT — Traffic Counts',
    url: 'https://gis.dot.state.oh.us/arcgis/rest/services/TIMS/Traffic_Counts/MapServer/0/query',
    aadtFields: ['AADT', 'AADT_TOTAL', 'CURRENT_AADT'],
    yearFields: ['AADT_YEAR', 'YEAR', 'COUNT_YEAR'],
    verified: false,
  },
  TX: {
    name: 'TxDOT — AADT Annuals',
    url: 'https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_AADT_Annuals/FeatureServer/0/query',
    aadtFields: ['AADT_RPT_QTY', 'AADT', 'T_ADT'],
    yearFields: ['AADT_RPT_YR', 'YEAR'],
    verified: false,
  },
  FL: {
    name: 'FDOT — Annual Average Daily Traffic',
    url: 'https://gis.fdot.gov/arcgis/rest/services/AADT/FeatureServer/0/query',
    aadtFields: ['AADT', 'AADT_FLOW'],
    yearFields: ['YEAR', 'YR'],
    verified: false,
  },
};

/** How far to look for a count station before giving up. */
export const DEFAULT_SEARCH_MILES = 0.25;

/** First field present on the record, from a list of candidates. */
function firstField(attributes, candidates) {
  for (const key of candidates) {
    if (attributes[key] !== undefined && attributes[key] !== null) {
      return { key, value: attributes[key] };
    }
  }
  return null;
}

/**
 * Ask an endpoint what it actually is.
 *
 * Returns its field names and one sample record. This is the verification step:
 * a URL that answers with real fields is a URL you can map, and one that
 * answers HTML with a 200 is caught by getJson's `not_json`.
 */
export async function probe(stateCode, opts = {}) {
  const source = DOT_SOURCES[String(stateCode).toUpperCase()];
  if (!source) {
    throw new Error(
      `no candidate endpoint for ${stateCode}. Known: ${Object.keys(DOT_SOURCES).join(', ')}. `
      + 'Add one to DOT_SOURCES with { name, url, aadtFields, yearFields }.',
    );
  }
  const params = new URLSearchParams({
    where: '1=1', outFields: '*', resultRecordCount: '1', returnGeometry: 'false', f: 'json',
  });
  const body = await getJson(`${source.url}?${params}`, opts);
  const sample = body?.features?.[0]?.attributes || {};
  const fields = (body?.fields || []).map((f) => f.name);
  return {
    state: String(stateCode).toUpperCase(),
    name: source.name,
    url: source.url,
    fieldNames: fields.length ? fields : Object.keys(sample),
    sample,
    // Whether the field names this registry guesses at are actually present.
    aadtFieldFound: firstField(sample, source.aadtFields)?.key || null,
    yearFieldFound: firstField(sample, source.yearFields)?.key || null,
  };
}

/**
 * The nearest traffic count to a point.
 *
 * Nearest by distance, and the distance is RETURNED rather than hidden: a count
 * station 0.9 miles away is measuring a different piece of road, and on a
 * signalised corner the difference between the two approaches can be 40%. What
 * counts as close enough is the reader's call, so they get the number.
 */
export async function trafficNear({ lat, lng }, stateCode, {
  searchMiles = DEFAULT_SEARCH_MILES, ...opts
} = {}) {
  const key = String(stateCode || '').toUpperCase();
  const source = DOT_SOURCES[key];
  if (!source) {
    return {
      fields: {},
      notes: [`no traffic-count endpoint registered for ${key || '(no state)'}; `
        + `known: ${Object.keys(DOT_SOURCES).join(', ')}`],
    };
  }

  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    distance: String(searchMiles * MILES_TO_M),
    units: 'esriSRUnit_Meter',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  });

  const body = await getJson(`${source.url}?${params}`, opts);
  const features = body?.features || [];
  if (!features.length) {
    return {
      fields: {},
      notes: [`${source.name}: no count station within ${searchMiles} miles`],
    };
  }

  // Nearest first. ArcGIS returns intersecting features in no useful order, so
  // "the first one" is not "the closest one".
  const scored = features
    .map((f) => {
      const g = f.geometry || {};
      const pt = g.x !== undefined ? { lat: g.y, lng: g.x } : null;
      return {
        attributes: f.attributes || {},
        miles: pt ? haversineMiles({ lat, lng }, pt) : null,
      };
    })
    .sort((a, b) => (a.miles ?? Infinity) - (b.miles ?? Infinity));

  const best = scored[0];
  const aadt = firstField(best.attributes, source.aadtFields);
  const year = firstField(best.attributes, source.yearFields);

  const notes = [];
  if (!source.verified) {
    notes.push(
      `${source.name} is an UNVERIFIED endpoint — it has never been confirmed against the `
      + `live service. Run "npm run enrich -- --probe=${key}" before relying on this.`,
    );
  }
  if (!aadt) {
    notes.push(
      `${source.name} answered, but none of ${source.aadtFields.join(', ')} was present. `
      + `Fields returned: ${Object.keys(best.attributes).slice(0, 12).join(', ')}. `
      + 'Add the right one to aadtFields.',
    );
    return { fields: {}, notes, nearestMiles: best.miles };
  }

  const value = Number(aadt.value);
  return {
    fields: { trafficCount: Number.isFinite(value) ? value : null },
    detail: {
      station: best.attributes,
      field: aadt.key,
      year: year ? year.value : null,
      miles: best.miles,
      candidates: scored.length,
    },
    notes,
    nearestMiles: best.miles,
  };
}
