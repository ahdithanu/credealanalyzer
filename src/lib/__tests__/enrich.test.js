import { describe, it, expect } from 'vitest';
import { getJson, FetchError, haversineMiles, redactUrl } from '../ingest/http';
import {
  geocode, tractsWithin, tractPopulations, enrichDemographics,
  assertNonOverlapping, DEFAULT_VINTAGES,
} from '../ingest/census';
import { trafficNear, probe, DOT_SOURCES } from '../ingest/dot';

/**
 * Public-data enrichment.
 *
 * The network is the one part these tests cannot exercise — the environment
 * this was written in could not reach an external host. So `fetchImpl` is
 * injected and the fixtures are the REAL response envelopes: the Census ACS
 * header-row-then-data-rows shape, the ArcGIS `{features:[{attributes}]}`
 * shape, and the failure modes that actually happen to these endpoints.
 *
 * What that buys and what it does not: every transformation, unit, filter and
 * sentinel below is genuinely tested. Whether the URLs are right is not, and
 * is what `--probe` is for.
 */

/** A fetch that answers from a map of url-substring → body. */
function fakeFetch(routes, { status = 200, contentType = 'application/json' } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!hit) throw new Error(`no fixture for ${url}`);
    const [, body] = hit;
    if (body instanceof Error) throw body;
    return {
      ok: status < 400,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  impl.calls = calls;
  return impl;
}

// ─── Real response envelopes ─────────────────────────────────────────────────

const GEOCODE_HIT = {
  result: {
    addressMatches: [{
      matchedAddress: '4500 MAPLE AVE, COLUMBUS, OH, 43214',
      coordinates: { x: -83.0207, y: 40.0517 },
      geographies: { 'Census Blocks': [{ STATE: '39', COUNTY: '049' }] },
    }],
  },
};

/** TIGERweb. CENTLAT/CENTLON arrive as strings, sometimes sign-prefixed. */
const TIGER = {
  fields: [{ name: 'GEOID' }, { name: 'CENTLAT' }, { name: 'CENTLON' }],
  features: [
    // ~0.5 mi away — inside
    { attributes: { GEOID: '39049001100', CENTLAT: '+40.0580', CENTLON: '-083.0250', STATE: '39', COUNTY: '049', TRACT: '001100' } },
    // ~1.4 mi — inside
    { attributes: { GEOID: '39049001200', CENTLAT: '+40.0720', CENTLON: '-083.0210', STATE: '39', COUNTY: '049', TRACT: '001200' } },
    // ~8 mi — a large tract clipping the ring, centroid far outside
    { attributes: { GEOID: '39049009900', CENTLAT: '+40.1680', CENTLON: '-083.0200', STATE: '39', COUNTY: '049', TRACT: '009900' } },
  ],
};

/** ACS: header row, then data rows. Not objects. */
const ACS_TRACTS = [
  ['B01003_001E', 'state', 'county', 'tract'],
  ['4210', '39', '049', '001100'],
  ['3880', '39', '049', '001200'],
  ['-666666666', '39', '049', '009900'],   // suppressed sentinel
];

const acsCounty = (pop) => [
  ['NAME', 'B01003_001E', 'state', 'county'],
  ['Franklin County, Ohio', String(pop), '39', '049'],
];

const DOT_FEATURES = {
  fields: [{ name: 'AADT' }, { name: 'AADT_YEAR' }],
  features: [
    // Farther away, listed first — ArcGIS does not sort by distance.
    { attributes: { AADT: 31000, AADT_YEAR: 2024 }, geometry: { x: -83.0240, y: 40.0530 } },
    // Nearest
    { attributes: { AADT: 16400, AADT_YEAR: 2024 }, geometry: { x: -83.0209, y: 40.0519 } },
  ],
};

// ─── The transport ───────────────────────────────────────────────────────────

describe('the http layer distinguishes the failures that matter', () => {
  it('a 200 carrying HTML is not a missing datum', () => {
    // The signature failure of a moved ArcGIS service: it answers a portal page
    // with HTTP 200. Reported as its own code so enrichment can say "this
    // endpoint is wrong" rather than "this property has no traffic count".
    const impl = fakeFetch({ example: '<!doctype html><title>Portal</title>' });
    return expect(getJson('https://example/x', { fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'not_json' });
  });

  it('unreachable and refused are different codes', async () => {
    await expect(getJson('https://example/x', {
      fetchImpl: fakeFetch({ example: new Error('ECONNREFUSED') }),
    })).rejects.toMatchObject({ code: 'unreachable' });

    await expect(getJson('https://example/x', {
      fetchImpl: fakeFetch({ example: {} }, { status: 500 }),
    })).rejects.toMatchObject({ code: 'http_error', status: 500 });
  });

  it('measures distance on a sphere', () => {
    // Columbus to Cleveland, ~125 miles.
    const d = haversineMiles({ lat: 39.9612, lng: -82.9988 }, { lat: 41.4993, lng: -81.6944 });
    expect(d).toBeGreaterThan(120);
    expect(d).toBeLessThan(132);
    expect(FetchError).toBeTruthy();
  });
});

// ─── Census ──────────────────────────────────────────────────────────────────

describe('census', () => {
  it('reads the geocoder envelope', async () => {
    const point = await geocode('4500 Maple Ave, Columbus OH', {
      fetchImpl: fakeFetch({ geocoding: GEOCODE_HIT }),
    });
    expect(point).toMatchObject({ lat: 40.0517, lng: -83.0207, state: '39', county: '049' });
  });

  it('an unmatched address is null, not a throw', async () => {
    const point = await geocode('nowhere', {
      fetchImpl: fakeFetch({ geocoding: { result: { addressMatches: [] } } }),
    });
    expect(point).toBeNull();
  });

  it('excludes a large tract that merely clips the ring', async () => {
    // Intersection alone would count that tract's whole population. On a
    // 3-mile ring one rural tract can be most of the answer.
    const { tracts, intersectingButExcluded, method } = await tractsWithin(
      { lat: 40.0517, lng: -83.0207 }, 3, { fetchImpl: fakeFetch({ tigerweb: TIGER }) },
    );
    expect(tracts.map((t) => t.geoid)).toEqual(['39049001100', '39049001200']);
    expect(intersectingButExcluded).toBe(1);
    expect(method).toBe('centroid-in-radius');
  });

  it('reads the ACS header-row shape, and its suppression sentinel', async () => {
    const pops = await tractPopulations(
      { state: '39', county: '049', vintage: 2023 },
      { fetchImpl: fakeFetch({ 'api.census.gov': ACS_TRACTS }) },
    );
    expect(pops.get('39049001100')).toBe(4210);
    // -666666666 is ACS's suppressed marker. Reading it as a population is how
    // a neighbourhood ends up with negative people.
    expect(pops.get('39049009900')).toBeNull();
  });

  it('sums the ring and says what it could not count', async () => {
    const out = await enrichDemographics('4500 Maple Ave, Columbus OH', {
      fetchImpl: fakeFetch({
        geocoding: GEOCODE_HIT,
        tigerweb: TIGER,
        'acs/acs5?get=B01003_001E&for=tract': ACS_TRACTS,
        'for=county': acsCounty(1_300_000),
      }),
    });
    // Only the two tracts inside the ring, and the third was excluded before
    // the suppression ever mattered.
    expect(out.fields.pop3mi).toBe(8090);
    expect(out.detail.tractCount).toBe(2);
  });
});

describe('the ACS growth trap', () => {
  it('refuses to difference overlapping 5-year estimates', () => {
    // The Census Bureau says plainly not to. 2019 (2015-2019) and 2023
    // (2019-2023) share a year, and the overlap damps the change toward zero.
    expect(() => assertNonOverlapping({ from: 2019, to: 2023 }))
      .toThrow(/overlap/);
    expect(() => assertNonOverlapping({ from: 2017, to: 2022 })).not.toThrow();
    expect(DEFAULT_VINTAGES.to - DEFAULT_VINTAGES.from).toBeGreaterThanOrEqual(5);
  });

  it('labels growth as county-level, because tract boundaries moved', () => {
    // ACS through 2020 is on 2010 census tracts and from 2021 on 2020 tracts,
    // so a tract-level 5-year comparison is not like-for-like — and the tracts
    // that changed most are the ones that grew. The number is still useful; a
    // county number wearing a 3-mile label is not.
    // Routed on the VINTAGE in the path, so the two calls genuinely differ —
    // an earlier version of this test matched both to one fixture and asserted
    // a 0% growth it had not actually computed.
    return enrichDemographics('4500 Maple Ave, Columbus OH', {
      fetchImpl: fakeFetch({
        geocoding: GEOCODE_HIT,
        tigerweb: TIGER,
        'acs/acs5?get=B01003_001E&for=tract': ACS_TRACTS,
        '/2017/acs/acs5?get=NAME': acsCounty(1_250_000),
        '/2022/acs/acs5?get=NAME': acsCounty(1_300_000),
      }),
    }).then((out) => {
      // 1,300,000 / 1,250,000 - 1 = 4%
      expect(out.fields.popGrowth3mi).toBeCloseTo(4, 6);
      expect(out.fields.popGrowthBasis).toBe('county');
      expect(out.notes.join(' ')).toMatch(/COUNTY-level/);
      expect(out.notes.join(' ')).toMatch(/boundaries changed/);
      expect(out.detail.countyName).toBe('Franklin County, Ohio');
    });
  });
});

// ─── DOT ─────────────────────────────────────────────────────────────────────

describe('traffic counts', () => {
  const point = { lat: 40.0517, lng: -83.0207 };

  it('takes the NEAREST station, not the first returned', async () => {
    // ArcGIS returns intersecting features in no useful order. Taking the first
    // here would report 31,000 instead of 16,400 — the difference between
    // passing your traffic criterion and not.
    const out = await trafficNear(point, 'OH', {
      fetchImpl: fakeFetch({ 'dot.state.oh.us': DOT_FEATURES }),
    });
    expect(out.fields.trafficCount).toBe(16400);
    expect(out.detail.year).toBe(2024);
    expect(out.detail.candidates).toBe(2);
  });

  it('returns the distance, because a station is not the corner', async () => {
    // On a signalised corner the two approaches can differ by 40%, so how far
    // away the measurement was taken is the reader's call, not this module's.
    const out = await trafficNear(point, 'OH', {
      fetchImpl: fakeFetch({ 'dot.state.oh.us': DOT_FEATURES }),
    });
    expect(out.detail.miles).toBeGreaterThan(0);
    expect(out.detail.miles).toBeLessThan(0.1);
  });

  it('warns on every use of an unverified endpoint', async () => {
    // None of these URLs has ever been called. A guess presented without that
    // caveat is worse than no data, because it is actionable.
    expect(Object.values(DOT_SOURCES).every((s) => s.verified === false)).toBe(true);
    const out = await trafficNear(point, 'OH', {
      fetchImpl: fakeFetch({ 'dot.state.oh.us': DOT_FEATURES }),
    });
    expect(out.notes.join(' ')).toMatch(/UNVERIFIED/);
    expect(out.notes.join(' ')).toMatch(/--probe=OH/);
  });

  it('an answering endpoint with unexpected fields is a mapping problem, said so', async () => {
    const out = await trafficNear(point, 'OH', {
      fetchImpl: fakeFetch({
        'dot.state.oh.us': {
          features: [{ attributes: { DAILY_VOLUME: 16400 }, geometry: { x: -83.02, y: 40.05 } }],
        },
      }),
    });
    expect(out.fields.trafficCount).toBeUndefined();
    expect(out.notes.join(' ')).toMatch(/none of AADT/);
    expect(out.notes.join(' ')).toMatch(/DAILY_VOLUME/);   // tells you what to map
  });

  it('no station nearby is a note, not a zero', async () => {
    const out = await trafficNear(point, 'OH', {
      fetchImpl: fakeFetch({ 'dot.state.oh.us': { features: [] } }),
    });
    expect(out.fields.trafficCount).toBeUndefined();
    expect(out.notes.join(' ')).toMatch(/no count station/);
  });

  it('an unregistered state names the ones that exist', async () => {
    const out = await trafficNear(point, 'WY', { fetchImpl: fakeFetch({}) });
    expect(out.notes.join(' ')).toMatch(/no traffic-count endpoint registered for WY/);
    expect(out.notes.join(' ')).toMatch(/OH/);
  });

  it('probe reports the real field names so a URL can be confirmed', async () => {
    const out = await probe('OH', { fetchImpl: fakeFetch({ 'dot.state.oh.us': DOT_FEATURES }) });
    expect(out.fieldNames).toContain('AADT');
    expect(out.aadtFieldFound).toBe('AADT');
    expect(out.yearFieldFound).toBe('AADT_YEAR');
  });

  it('probe on an unknown state explains how to add one', async () => {
    await expect(probe('WY', { fetchImpl: fakeFetch({}) }))
      .rejects.toThrow(/Add one to DOT_SOURCES/);
  });
});

/**
 * The Census API key.
 *
 * Found by running the real thing: `npm run markets` came back with thirty-six
 * identical failures reading "returned 200 but not JSON (<html …<title>Missing
 * Key</title>…". The Census answers a keyless request to this dataset with an
 * HTML page at HTTP 200, so without the not_json guard it would have arrived
 * as thirty-six metros that apparently have no population.
 */
describe('the Census key, and never printing it', () => {
  const MISSING_KEY_PAGE =
    '<html style="font-size: 14px;"> <head> <title>Missing Key</title> '
    + '<link rel="stylesheet"></head><body>A key is required.</body></html>';
  const INVALID_KEY_PAGE = '<html><head><title>Invalid Key</title></head><body>no</body></html>';

  it('names a keyless request as such instead of as a parse failure', async () => {
    // "returned 200 but not JSON" is true and useless: the fix is a two-minute
    // signup, and nothing in that message says so.
    const impl = fakeFetch({ 'api.census.gov': MISSING_KEY_PAGE });
    await expect(getJson('https://api.census.gov/data/2022/acs/acs5?get=NAME', { fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'missing_key' });

    await expect(getJson('https://api.census.gov/x', { fetchImpl: impl }))
      .rejects.toThrow(/key_signup/);
  });

  it('separates a rejected key from an absent one', async () => {
    const impl = fakeFetch({ 'api.census.gov': INVALID_KEY_PAGE });
    await expect(getJson('https://api.census.gov/x', { fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('still reports an ordinary moved endpoint as not_json', async () => {
    // The key detection must not swallow the ArcGIS portal-page case it sits
    // next to; that one is a wrong URL, not a missing credential.
    const impl = fakeFetch({ 'gis.dot': '<html><head><title>ArcGIS Portal</title></head></html>' });
    await expect(getJson('https://gis.dot.state.oh.us/x', { fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'not_json' });
  });

  it('never puts the key in the message, the context, or anything logged', async () => {
    // Every error here embeds the URL it failed on, which is right to report
    // and wrong to report verbatim once the query string carries a credential.
    const SECRET = 'abc123secretkey';
    const url = `https://api.census.gov/data/2022/acs/acs5?get=NAME&key=${SECRET}`;

    for (const [routes, opts] of [
      [{ 'api.census.gov': MISSING_KEY_PAGE }, {}],
      [{ 'api.census.gov': '<html>portal</html>' }, {}],
      [{ 'api.census.gov': {} }, { status: 500 }],
      [{ 'api.census.gov': new Error('socket hang up') }, {}],
    ]) {
      const err = await getJson(url, { fetchImpl: fakeFetch(routes, opts) })
        .then(() => null, (e) => e);
      expect(err, JSON.stringify(routes)).toBeInstanceOf(FetchError);
      expect(err.message).not.toContain(SECRET);
      expect(err.url).not.toContain(SECRET);
      expect(err.message).toContain('key=REDACTED');
    }
  });

  it('redacts the key and nothing else, so the message still says what failed', () => {
    // Over-redaction is safe and useless. `for=...:18140` is the part you read
    // to find a transposed CBSA code, and swallowing the rest of the query
    // string with the key takes it with it.
    const masked = redactUrl('https://api.census.gov/data/2022/acs/acs5'
      + '?get=NAME&key=abc123&for=metropolitan+statistical+area:18140&x=1');
    expect(masked).toContain('key=REDACTED');
    expect(masked).not.toContain('abc123');
    expect(masked).toContain('get=NAME');
    expect(masked).toContain('18140');
    expect(masked).toContain('x=1');
  });
});

describe('the key reaches the endpoints that need it', () => {
  it('is appended only when set, and url-encoded', async () => {
    const { censusKeyParam } = await import('../ingest/acsMarkets');
    expect(censusKeyParam(undefined)).toBe('');
    expect(censusKeyParam('')).toBe('');
    // Keeps working if the Census relaxes the requirement again, and a keyless
    // run then fails with the sign-up link rather than with a parse error.
    expect(censusKeyParam('a b&c')).toBe('&key=a%20b%26c');
  });

  it('survives the trailing newline every copy-paste carries', async () => {
    // `export CENSUS_API_KEY=$(cat key.txt)`, a heredoc and a .env line all
    // keep the newline. Untrimmed it encodes to %0A, the Census rejects the
    // key, and the report blames a key that was right — which is exactly what
    // happened the first time this was run for real.
    const { censusKeyParam } = await import('../ingest/acsMarkets');
    const KEY = '0123456789abcdef0123456789abcdef01234567';
    for (const raw of [`${KEY}\n`, ` ${KEY}`, `${KEY}\r\n`, `\t${KEY} `]) {
      expect(censusKeyParam(raw), JSON.stringify(raw)).toBe(`&key=${KEY}`);
    }
    // Whitespace INSIDE is not whitespace around it, and must still encode.
    expect(censusKeyParam('ab cd')).toBe('&key=ab%20cd');
  });

  it('describes the key by shape, and never by value', async () => {
    // A rejected key has two causes with identical symptoms: a mangled paste,
    // or a well-formed key that was never activated from the confirmation
    // email. Only the shape separates them, and printing the key to find out
    // is not an option.
    const { describeKey } = await import('../ingest/acsMarkets');
    const KEY = '0123456789abcdef0123456789abcdef01234567';

    expect(describeKey(KEY)).toMatchObject({ present: true, length: 40, looksValid: true });
    expect(describeKey('0123456789abcdef')).toMatchObject({ length: 16, looksValid: false });
    expect(describeKey(`"${KEY}"`)).toMatchObject({ looksQuoted: true, looksValid: false });
    expect(describeKey(`${KEY}\n`)).toMatchObject({ hadSurroundingWhitespace: true, looksValid: true });
    expect(describeKey(undefined)).toMatchObject({ present: false, looksValid: false });
    // An uppercase or non-hex key is not a Census key.
    expect(describeKey(KEY.toUpperCase()).looksValid).toBe(false);

    for (const probe of [KEY, `"${KEY}"`, `${KEY}\n`]) {
      expect(JSON.stringify(describeKey(probe))).not.toContain(KEY);
    }
  });

  it('rides on the ACS calls and on nothing else', async () => {
    // The geocoder and TIGERweb do NOT take a key. Sending one there is a
    // credential handed to an endpoint that never asked for it.
    // A tract inside the ring, so the TRACT ACS call fires as well as the
    // county one. With `features: []` only the county call ran, and a key
    // dropped from the tract URL went unnoticed.
    const impl = fakeFetch({
      'geocoding.geo.census.gov': GEOCODE_HIT,
      'tigerweb': {
        features: [{
          attributes: {
            GEOID: '39049007200', CENTLAT: '40.0500', CENTLON: '-83.0200',
            STATE: '39', COUNTY: '049', TRACT: '007200',
          },
        }],
      },
      'for=tract': [['B01003_001E', 'state', 'county', 'tract'], ['4210', '39', '049', '007200']],
      'api.census.gov': [['NAME', 'B01003_001E', 'state', 'county'], ['Franklin County, Ohio', '1326063', '39', '049']],
    });
    await enrichDemographics('4500 Maple Ave, Columbus, OH', { fetchImpl: impl, apiKey: 'K' });

    const acs = impl.calls.filter((u) => u.includes('api.census.gov'));
    // County (two vintages) and tract — not just one of them.
    expect(acs.length).toBeGreaterThanOrEqual(3);
    expect(acs.some((u) => u.includes('for=tract'))).toBe(true);
    for (const u of acs) expect(u).toContain('&key=K');
    for (const u of impl.calls.filter((u) => !u.includes('api.census.gov'))) {
      expect(u).not.toContain('key=');
    }
  });

  it('reaches the market sourcing calls too', async () => {
    const { cbsaFigures } = await import('../ingest/acsMarkets');
    const impl = fakeFetch({ 'api.census.gov': [['NAME', 'B01003_001E'], ['Columbus, OH Metro Area', '2151017']] });
    await cbsaFigures('18140', { vintage: 2022, apiKey: 'K' }, { fetchImpl: impl });
    expect(impl.calls[0]).toContain('&key=K');
  });
});
