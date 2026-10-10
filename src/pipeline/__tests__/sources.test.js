import {
  parseCensusACS, parseBLS, yoyGrowth, parseAssessor, parseTrafficCounts,
  SOURCES, sourcesFor, licensedOnlyFeatures, createClient, ParseError, ACS_VARIABLES,
  buildRequest, allowedHostsFor, attributionsFor, parseDelimited,
} from '../sources';
import { censusACS, blsCES, blsFailure, hcadRoll, dcadRoll, txdotAADT, fixtureFetch } from '../fixtures';

describe('parseCensusACS', () => {
  const recs = parseCensusACS(censusACS, { vintage: 2023 });

  it('maps opaque variable codes to named fields', () => {
    expect(recs[0].population).toBe(7_340_118);
    expect(recs[0].medianHHI).toBe(72_004);
    expect(ACS_VARIABLES.B01003_001E).toBe('population');
  });

  it('carries the geography id and vintage', () => {
    expect(recs[0].geoId).toBe('26420');
    expect(recs[0].vintage).toBe(2023);
  });

  it('reads a suppressed cell as null, not as a huge negative number', () => {
    // ACS encodes suppression as -666666666. Treating that as a value would
    // put a market's median income nine figures below zero.
    const corpus = recs.find((r) => r.geoId === '18580');
    expect(corpus.medianHHI).toBeNull();
    expect(corpus.population).toBe(444_258);
  });

  it('rejects a payload that is not the array-of-arrays shape', () => {
    expect(() => parseCensusACS({ data: [] })).toThrow(ParseError);
    expect(() => parseCensusACS([['NAME']])).toThrow(/header row/);
  });
});

describe('parseBLS', () => {
  const obs = parseBLS(blsCES);

  it('flattens series data into dated observations', () => {
    expect(obs).toHaveLength(3);
    expect(obs[obs.length - 1]).toMatchObject({ year: 2026, month: 6, value: 3489.2 });
  });

  it('ignores the M13 annual average', () => {
    // M13 is an annual mean; counted as a month it doubles a year's weight.
    expect(obs.some((o) => o.value === 3450)).toBe(false);
  });

  it('anchors each observation to the first of its month', () => {
    expect(obs[0].validFrom).toBe('2024-06-01');
  });

  it('throws with the upstream message when the request did not succeed', () => {
    expect(() => parseBLS(blsFailure)).toThrow(/No Data Available/);
  });

  it('throws on a payload with no series', () => {
    expect(() => parseBLS({ Results: {} })).toThrow(/no Results.series/);
  });

  it('computes year-over-year growth from matching months', () => {
    // 3489.2 against 3407.1 a year earlier.
    expect(yoyGrowth(obs)).toBeCloseTo(((3489.2 - 3407.1) / 3407.1) * 100, 6);
  });

  it('returns null when the prior year is missing rather than comparing months', () => {
    expect(yoyGrowth(obs.slice(-1))).toBeNull();
    expect(yoyGrowth([])).toBeNull();
  });
});

describe('parseAssessor', () => {
  it('adapts a county field map onto one shape', () => {
    const [first] = parseAssessor(hcadRoll, { county: 'hcad' });
    expect(first).toMatchObject({
      parcelId: 'parcel:hcad:0001234567',
      ownerName: 'SUNBELT CAR WASH HOLDINGS LLC',
      appraisedValue: 2_145_000,
      taxRate: 2.81,
      taxYear: 2025,
    });
  });

  it('handles a different county with different column names', () => {
    const [first] = parseAssessor(dcadRoll, { county: 'dcad' });
    expect(first.parcelId).toBe('parcel:dcad:00000700123400000');
    expect(first.taxRate).toBe(2.42);
  });

  it('derives the valid window from the tax year', () => {
    const [first] = parseAssessor(hcadRoll, { county: 'hcad' });
    expect(first.validFrom).toBe('2025-01-01');
    expect(first.validTo).toBe('2026-01-01');
  });

  it('refuses a county with no field map rather than guessing columns', () => {
    expect(() => parseAssessor(hcadRoll, { county: 'unknown' })).toThrow(/no field map/);
  });

  it('throws when a record has no account number', () => {
    expect(() => parseAssessor([{ owner_name: 'X' }], { county: 'hcad' })).toThrow(/required field/);
  });
});

describe('parseTrafficCounts', () => {
  it('reads the ArcGIS attributes shape', () => {
    const recs = parseTrafficCounts(txdotAADT);
    expect(recs[0]).toMatchObject({ stationId: 'TX-0451', aadt: 42000, year: 2025 });
  });

  it('drops stations with no count rather than emitting a null reading', () => {
    expect(parseTrafficCounts(txdotAADT)).toHaveLength(2);
  });
});

describe('source registry', () => {
  it('declares a licence for every source', () => {
    for (const s of Object.values(SOURCES)) {
      expect(['public-domain', 'attribution', 'licensed']).toContain(s.licence);
    }
  });

  it('finds the sources that provide a feature', () => {
    expect(sourcesFor('population').map((s) => s.id)).toContain('census.acs5');
    expect(sourcesFor('effectiveTaxRate').map((s) => s.id)).toContain('assessor.hcad');
  });

  it('identifies the features only a licensed source can supply', () => {
    // These are the ones that stay seed data until a subscription exists.
    const licensed = licensedOnlyFeatures(['population', 'supplyPipeline', 'marketCapRate', 'trafficCount']);
    expect(licensed.sort()).toEqual(['marketCapRate', 'supplyPipeline']);
  });

  it('builds a full request descriptor from parameters', () => {
    const req = buildRequest('census.acs5', { params: { vintage: 2023 } });
    expect(req.url).toContain('/2023/acs/acs5');
    expect(req.url).toContain('B01003_001E');
    expect(req.method).toBe('GET');
    expect(req.accept).toBe('json');
  });

  it('declares the host each source reaches, for the egress allowlist', () => {
    expect(allowedHostsFor([{ sourceId: 'census.acs5' }, { sourceId: 'bls.ces' }]).sort())
      .toEqual(['api.bls.gov', 'api.census.gov']);
    // A licensed source has no host and contributes nothing to the allowlist.
    expect(allowedHostsFor([{ sourceId: 'costar.market' }])).toEqual([]);
  });

  it('refuses to build a request for a source that is not fetchable', () => {
    expect(() => buildRequest('costar.market')).toThrow(/not fetchable/);
    expect(() => buildRequest('nope')).toThrow(/unknown source/);
  });
});

describe('createClient', () => {
  const noSleep = () => Promise.resolve();

  it('requires an injected fetch so the pipeline never hard-codes a transport', () => {
    expect(() => createClient({})).toThrow(/fetchImpl/);
  });

  it('returns the parsed body on success', async () => {
    const get = createClient({ fetchImpl: fixtureFetch({ 'acs5': censusACS }), sleep: noSleep });
    const res = await get('https://api.census.gov/data/2023/acs/acs5?get=NAME');
    expect(res.status).toBe(200);
    expect(res.body[0][0]).toBe('NAME');
  });

  it('retries a 429 and then succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return calls < 3
        ? { ok: false, status: 429, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const get = createClient({ fetchImpl, sleep: noSleep });
    await expect(get('x')).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(3);
  });

  it('gives up after maxRetries', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; };
    const get = createClient({ fetchImpl, maxRetries: 2, sleep: noSleep });
    await expect(get('x')).rejects.toThrow(/upstream 503/);
    expect(calls).toBe(3);                        // initial + 2 retries
  });

  it('does not retry a 404, which will never succeed', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; };
    const get = createClient({ fetchImpl, sleep: noSleep });
    await expect(get('x')).rejects.toThrow(/upstream 404/);
    expect(calls).toBe(1);
  });

  it('spaces requests by the configured interval', async () => {
    const waits = [];
    const get = createClient({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      minIntervalMs: 250,
      sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
    });
    await get('a');
    await get('b');
    expect(waits.some((w) => w > 0)).toBe(true);
  });
});

describe('buildRequest — auth and shape per source', () => {
  it('omits the Census key when none is configured', () => {
    const req = buildRequest('census.acs5', { params: { vintage: 2023 } });
    expect(req.url).not.toContain('key=');
  });

  it('adds the Census key as a query parameter when supplied', () => {
    const req = buildRequest('census.acs5', { params: { vintage: 2023 }, secrets: { CENSUS_API_KEY: 'k123456' } });
    expect(new URL(req.url).searchParams.get('key')).toBe('k123456');
  });

  it('uses the keyless GET form of BLS when no key is configured', () => {
    const req = buildRequest('bls.ces', { params: { seriesId: 'SMU48264200000000001' } });
    expect(req.method).toBe('GET');
    expect(req.url).toContain('SMU48264200000000001');
    expect(req.body).toBeUndefined();
  });

  it('uses the POST form with a registration key, which is the only multi-series path', () => {
    const req = buildRequest('bls.ces', {
      params: { seriesIds: ['A', 'B'], startYear: 2024, endYear: 2026 },
      secrets: { BLS_API_KEY: 'bls-key-1234' },
    });
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/json');
    const body = JSON.parse(req.body);
    expect(body.seriesid).toEqual(['A', 'B']);
    expect(body.startyear).toBe('2024');
    expect(body.registrationkey).toBe('bls-key-1234');
  });

  it('refuses a multi-series BLS request without a key rather than failing upstream', () => {
    expect(() => buildRequest('bls.ces', { params: { seriesIds: ['A', 'B'] } }))
      .toThrow(/requires BLS_API_KEY/);
  });

  it('marks the assessor roll as a binary archive with an unpack descriptor', () => {
    // A tax roll is a zip of pipe-delimited text; reading it as json fails
    // in a way that looks like a parser bug rather than a transport one.
    const req = buildRequest('assessor.hcad', { params: { taxYear: 2025 } });
    expect(req.accept).toBe('binary');
    expect(req.unpack.format).toBe('zip');
    expect(req.unpack.delimiter).toBe('|');
  });

  it('builds a paginated ArcGIS query and advances the cursor', () => {
    const req = buildRequest('txdot.aadt', { params: { year: 2025, offset: 0, pageSize: 500 } });
    expect(new URL(req.url).searchParams.get('resultOffset')).toBe('0');
    const next = SOURCES['txdot.aadt'].nextPage({ params: { year: 2025, offset: 0, pageSize: 500 }, body: { exceededTransferLimit: true } });
    expect(next.offset).toBe(500);
    expect(SOURCES['txdot.aadt'].nextPage({ params: {}, body: { features: [] } })).toBeNull();
  });

  it('names the attribution a source requires', () => {
    expect(attributionsFor(['assessor.hcad'])).toEqual(['Harris County Appraisal District']);
    expect(attributionsFor(['census.acs5'])).toEqual([]);
  });
});

describe('parseDelimited', () => {
  it('parses pipe-delimited roll text into records', () => {
    const recs = parseDelimited('acct|owner_name\n123| SUNBELT LLC \n456|KATY LP');
    expect(recs).toEqual([
      { acct: '123', owner_name: 'SUNBELT LLC' },
      { acct: '456', owner_name: 'KATY LP' },
    ]);
  });

  it('returns nothing for an empty or header-only file', () => {
    expect(parseDelimited('')).toEqual([]);
    expect(parseDelimited('acct|owner')).toEqual([]);
  });

  it('tolerates CRLF line endings, which county exports use', () => {
    expect(parseDelimited('a|b\r\n1|2\r\n')).toEqual([{ a: '1', b: '2' }]);
  });
});
