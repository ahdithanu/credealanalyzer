/**
 * Source registry and parsers.
 *
 * Each source declares what it provides, what it costs, and what licence it
 * carries — because "can we ship this figure to a client?" is a real question
 * with a real answer, and it belongs next to the data, not in someone's head.
 *
 * Parsers are pure: payload in, typed records out. Fetching is injected, so the
 * whole pipeline is testable against fixtures without a network.
 */

/** @typedef {'public-domain'|'attribution'|'licensed'} Licence */

const req = (rec, field, source) => {
  const v = rec[field];
  if (v === undefined || v === null || v === '') {
    throw new ParseError(`${source}: record missing required field "${field}"`, rec);
  }
  return v;
};

export class ParseError extends Error {
  constructor(message, record) {
    super(message);
    this.name = 'ParseError';
    this.record = record;
  }
}

const numeric = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  // Census encodes suppressed cells as large negative sentinels.
  if (!Number.isFinite(n) || n <= -666666666) return null;
  return n;
};

// ── Census ACS ──────────────────────────────────────────────────────────────

/**
 * ACS returns an array of arrays with the header as row zero. Variable codes
 * are opaque, so the mapping lives here rather than at the call site.
 */
export const ACS_VARIABLES = {
  B01003_001E: 'population',
  B19013_001E: 'medianHHI',
  B25077_001E: 'medianHomeValue',
  B23025_004E: 'employed',
};

export function parseCensusACS(payload, { vintage } = {}) {
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new ParseError('census: expected an array of arrays with a header row', payload);
  }
  const [header, ...rows] = payload;
  const geoIdx = header.findIndex((h) => /statistical area|county|tract/i.test(h));
  return rows.map((row) => {
    const rec = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    const out = {
      geoId: geoIdx >= 0 ? row[geoIdx] : null,
      name: rec.NAME ?? null,
      vintage: vintage ?? null,
    };
    for (const [code, field] of Object.entries(ACS_VARIABLES)) {
      if (code in rec) out[field] = numeric(rec[code]);
    }
    if (!out.geoId) throw new ParseError('census: row has no geography id', rec);
    return out;
  });
}

// ── BLS ─────────────────────────────────────────────────────────────────────

/**
 * BLS wraps everything in Results.series[].data[]. Values are strings, periods
 * are M01..M13 where M13 is an annual average that must not be read as a month.
 */
export function parseBLS(payload) {
  if (payload?.status && payload.status !== 'REQUEST_SUCCEEDED') {
    throw new ParseError(`bls: request not succeeded (${payload.status}) ${(payload.message ?? []).join('; ')}`, payload);
  }
  const series = payload?.Results?.series;
  if (!Array.isArray(series)) throw new ParseError('bls: payload has no Results.series', payload);

  const out = [];
  for (const s of series) {
    for (const d of s.data ?? []) {
      if (d.period === 'M13') continue;           // annual average, not a month
      const month = Number(String(d.period).replace('M', ''));
      if (!Number.isFinite(month) || month < 1 || month > 12) continue;
      out.push({
        seriesId: s.seriesID,
        year: Number(d.year),
        month,
        value: numeric(d.value),
        // First of the month, as the valid-time anchor.
        validFrom: `${d.year}-${String(month).padStart(2, '0')}-01`,
      });
    }
  }
  return out.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
}

/** Year-over-year growth from a monthly series, as a percentage. */
export function yoyGrowth(observations) {
  const byDate = [...observations].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  const latest = byDate[byDate.length - 1];
  if (!latest) return null;
  const target = `${latest.year - 1}-${String(latest.month).padStart(2, '0')}-01`;
  const prior = byDate.find((o) => o.validFrom === target);
  if (!prior || !prior.value || !latest.value) return null;
  return ((latest.value - prior.value) / prior.value) * 100;
};

// ── County assessor ─────────────────────────────────────────────────────────

/**
 * Assessor rolls differ per county, so a per-county field map adapts them onto
 * one shape. Owner name and mailing address are the entity-resolution inputs;
 * everything else is an observation.
 */
export const ASSESSOR_FIELD_MAPS = {
  hcad: { account: 'acct', owner: 'owner_name', ownerAddress: 'owner_addr', situs: 'site_addr', value: 'tot_appr_val', year: 'tax_yr', rate: 'tot_tax_rate', lat: 'lat', lng: 'lon' },
  dcad: { account: 'ACCOUNT_NUM', owner: 'OWNER_NAME1', ownerAddress: 'OWNER_ADDRESS', situs: 'SITE_ADDRESS', value: 'TOT_VAL', year: 'TAX_YEAR', rate: 'TOTAL_RATE', lat: 'LATITUDE', lng: 'LONGITUDE' },
};

export function parseAssessor(payload, { county, taxYear } = {}) {
  const map = ASSESSOR_FIELD_MAPS[county];
  if (!map) throw new ParseError(`assessor: no field map for county "${county}"`, null);
  const rows = Array.isArray(payload) ? payload : payload?.records;
  if (!Array.isArray(rows)) throw new ParseError('assessor: expected an array of records', payload);

  return rows.map((r) => {
    const account = String(req(r, map.account, 'assessor'));
    const year = Number(r[map.year] ?? taxYear);
    if (!Number.isFinite(year)) throw new ParseError('assessor: record has no usable tax year', r);
    return {
      parcelId: `parcel:${county}:${account}`,
      account,
      county,
      ownerName: r[map.owner] ?? null,
      ownerAddress: r[map.ownerAddress] ?? null,
      situsAddress: r[map.situs] ?? null,
      appraisedValue: numeric(r[map.value]),
      taxYear: year,
      taxRate: numeric(r[map.rate]),
      lat: numeric(r[map.lat]),
      lng: numeric(r[map.lng]),
      validFrom: `${year}-01-01`,
      validTo: `${year + 1}-01-01`,
    };
  });
}

// ── Traffic counts ──────────────────────────────────────────────────────────

/** ArcGIS FeatureServer shape, as TxDOT and FDOT both publish. */
export function parseTrafficCounts(payload) {
  const features = payload?.features;
  if (!Array.isArray(features)) throw new ParseError('traffic: payload has no features array', payload);
  return features.map((f) => {
    const a = f.attributes ?? f.properties ?? {};
    return {
      stationId: String(a.STATION_ID ?? a.station_id ?? ''),
      aadt: numeric(a.AADT_RPT_QTY ?? a.AADT ?? a.aadt),
      year: Number(a.YEAR ?? a.year),
      lat: numeric(a.LAT ?? a.latitude),
      lng: numeric(a.LON ?? a.longitude),
    };
  }).filter((r) => r.aadt !== null);
}

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Every source, with its licence. `licensed` sources must never be
 * redistributed in a client-facing artifact — the memo generator reads this.
 */
export const SOURCES = {
  'census.acs5': {
    id: 'census.acs5', name: 'Census ACS 5-year',
    licence: 'public-domain', cadence: 'annual', parser: parseCensusACS,
    provides: ['population', 'medianHHI', 'popGrowth5y'],
    url: ({ vintage = 2023, variables = Object.keys(ACS_VARIABLES), geo = 'metropolitan statistical area/micropolitan statistical area:*' }) =>
      `https://api.census.gov/data/${vintage}/acs/acs5?get=NAME,${variables.join(',')}&for=${encodeURIComponent(geo)}`,
  },
  'bls.ces': {
    id: 'bls.ces', name: 'BLS Current Employment Statistics',
    licence: 'public-domain', cadence: 'monthly', parser: parseBLS,
    provides: ['employmentGrowth'],
    url: ({ seriesId }) => `https://api.bls.gov/publicAPI/v2/timeseries/data/${seriesId}`,
  },
  'assessor.hcad': {
    id: 'assessor.hcad', name: 'Harris County Appraisal District',
    licence: 'attribution', cadence: 'annual', parser: parseAssessor,
    provides: ['effectiveTaxRate', 'ownership', 'appraisedValue'],
    url: ({ taxYear }) => `https://download.hcad.org/data/CAMA/${taxYear}/Real_acct_owner.zip`,
  },
  'txdot.aadt': {
    id: 'txdot.aadt', name: 'TxDOT annual average daily traffic',
    licence: 'public-domain', cadence: 'annual', parser: parseTrafficCounts,
    provides: ['trafficCount'],
    url: ({ year }) => `https://services.arcgis.com/TxDOT/aadt/FeatureServer/0/query?where=YEAR%3D${year}&outFields=*&f=json`,
  },
  'costar.market': {
    id: 'costar.market', name: 'CoStar market analytics',
    licence: 'licensed', cadence: 'quarterly', parser: null,
    provides: ['supplyPipeline', 'marketCapRate', 'rentGrowth'],
    url: null,
    note: 'Licensed. Requires a subscription and a redistribution review before any figure reaches a client-facing artifact.',
  },
};

/** Which registered sources can supply a given feature. */
export function sourcesFor(feature) {
  return Object.values(SOURCES).filter((s) => s.provides.includes(feature));
}

/** Features with no non-licensed source — the ones that stay seed data. */
export function licensedOnlyFeatures(features) {
  return features.filter((f) => {
    const s = sourcesFor(f);
    return s.length > 0 && s.every((x) => x.licence === 'licensed');
  });
}

/**
 * A fetch client with rate limiting and retry. `fetchImpl` is injected so the
 * pipeline runs against fixtures in tests and against the network in
 * production, with no branch inside the pipeline itself.
 */
export function createClient({ fetchImpl, minIntervalMs = 0, maxRetries = 3, sleep = defaultSleep } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createClient needs a fetchImpl');
  let last = 0;

  return async function get(url, { signal } = {}) {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();

    let attempt = 0;
    for (;;) {
      try {
        const res = await fetchImpl(url, { signal });
        if (res.status === 429 || res.status >= 500) {
          throw Object.assign(new Error(`upstream ${res.status}`), { retryable: true, status: res.status });
        }
        if (!res.ok) throw Object.assign(new Error(`upstream ${res.status}`), { retryable: false, status: res.status });
        return { url, status: res.status, body: await res.json() };
      } catch (err) {
        attempt++;
        if (!err.retryable || attempt > maxRetries) throw err;
        await sleep(2 ** attempt * 100);      // exponential backoff
      }
    }
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
