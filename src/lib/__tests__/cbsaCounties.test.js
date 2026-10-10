/**
 * The CBSA → county crosswalk, and the growth computed over it.
 *
 * This layer exists because differencing two CBSA populations measures the
 * delineation as much as the people. Every assertion here guards a way for the
 * fix to reintroduce the bug it replaces — by binding to the wrong layer, by
 * counting a neighbouring county, or by summing an incomplete set.
 *
 * Nothing here has made a live call: census.gov is off the egress allowlist
 * where it was written. The fixtures are the real response envelopes and
 * `npm run markets -- --probe-counties` is what confirms the socket.
 */

import {
  discoverLayers, countiesInCbsa, pointInRings, LAYER_PATTERNS, CrosswalkError,
  listServices, MAX_SERVICES_PROBED, MAX_LAYERS_COUNTED,
  chooseByFeatureCount, EXPECTED_FEATURES,
} from '../ingest/cbsaCounties';
import { growthOverFixedCounties, countyPopulations } from '../ingest/acsMarkets';

const POP = 'B01003_001E';

/** A fetch answering from url-substring → body, recording what was asked. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!hit) throw new Error(`no fixture for ${url}`);
    const body = hit[1];
    if (body instanceof Error) throw body;
    return {
      ok: true,
      status: 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  impl.calls = calls;
  return impl;
}

/**
 * The REST directory, and the services in it.
 *
 * Shaped from the real run: `tigerWMS_Current` carries every geography BELOW a
 * county — tracts, blocks, places, County Subdivisions — and neither Counties
 * nor CBSAs. Those live in other services, and not necessarily the same one as
 * each other.
 */
const DIRECTORY = { folders: ['TIGERweb'], services: [] };
const FOLDER = {
  services: [
    { name: 'TIGERweb/tigerWMS_Current', type: 'MapServer' },
    { name: 'TIGERweb/State_County', type: 'MapServer' },
    { name: 'TIGERweb/Generalized_ACS2023', type: 'MapServer' },
    { name: 'TIGERweb/Labels', type: 'MapServer' },
  ],
};
const SUBCOUNTY_SERVICE = {
  layers: [
    { id: 0, name: 'Census Tracts' },
    { id: 82, name: 'County Subdivisions' },
    { id: 83, name: 'County Subdivisions Labels' },
    { id: 90, name: 'Incorporated Places' },
  ],
};
/**
 * Twenty-one layers all called "Counties" — the shape the real service has.
 * TIGERweb stacks the same geography at several vintages and generalisation
 * tiers under identical names, so only the feature counts separate them.
 */
const STATE_COUNTY_SERVICE = {
  layers: [
    { id: 84, name: 'States' },
    { id: 85, name: 'Counties' },        // an earlier vintage: too few features
    { id: 86, name: 'Counties' },        // the real one
    { id: 87, name: 'Counties Labels' },
    { id: 88, name: 'Counties' },        // another tier
    { id: 89, name: 'Counties 500K' },   // generalised for small-scale maps
    { id: 90, name: 'Counties 20M' },
    { id: 91, name: 'County Subdivisions' },
  ],
};

/** Feature counts by layer id, as returnCountOnly answers them. */
const FEATURE_COUNTS = {
  84: 56, 85: 400, 86: 3143, 88: 3143, 89: 3143, 90: 3143, 91: 36000,
  1: 175, 3: 31, 4: 393, 5: 935, 6: 542, 7: 393, 8: 38,
};
const countRoutes = Object.fromEntries(
  Object.entries(FEATURE_COUNTS).map(([id, count]) => [
    `/${id}/query?where=1%3D1&returnCountOnly=true`, { count },
  ]),
);
/**
 * The CBSA service's real layer list, from the probe.
 *
 * Note what is NOT here: any layer called "Metropolitan Statistical
 * Area/Micropolitan Statistical Area". That is the ACS API's name for the
 * geography, and the pattern was written from it — so it matched nothing
 * across thirty services. These are the names TIGERweb actually uses.
 */
const GENERALIZED_SERVICE = {
  layers: [
    { id: 1, name: 'Combined Statistical Areas' },
    { id: 2, name: 'Combined Statistical Areas 500K' },
    { id: 3, name: 'Metropolitan Divisions' },
    { id: 4, name: 'Metropolitan Statistical Areas' },
    { id: 5, name: 'Metropolitan and Micropolitan Statistical Areas' },
    { id: 6, name: 'Micropolitan Statistical Areas' },
    { id: 7, name: 'Metropolitan Statistical Areas 500K' },
    { id: 8, name: 'Metropolitan New England City and Town Areas' },
    { id: 9, name: 'Labels' },
  ],
};

/** Every route a discovery needs, with the two layers in DIFFERENT services. */
const DISCOVERY = {
  ...countRoutes,
  'arcgis/rest/services?f=json': DIRECTORY,
  'arcgis/rest/services/TIGERweb?f=json': FOLDER,
  'tigerWMS_Current/MapServer?f=json': SUBCOUNTY_SERVICE,
  'State_County/MapServer?f=json': STATE_COUNTY_SERVICE,
  'Generalized_ACS2023/MapServer?f=json': GENERALIZED_SERVICE,
  'Labels/MapServer?f=json': { layers: [{ id: 1, name: 'Counties Labels' }] },
};
const SERVICE_ROOT = STATE_COUNTY_SERVICE;

/** A 10×10 box CBSA, with three counties: two inside, one over the border. */
const CBSA_POLYGON = {
  features: [{
    attributes: { GEOID: '23540', NAME: 'Gainesville, FL Metro Area' },
    geometry: { rings: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]] },
  }],
};
const county = (geoid, state, cty, name, lat, lng) => ({
  attributes: {
    GEOID: geoid, STATE: state, COUNTY: cty, NAME: name, BASENAME: name,
    CENTLAT: String(lat), CENTLON: String(lng),
  },
});
const COUNTIES = {
  features: [
    county('12001', '12', '001', 'Alachua', 5, 2),
    county('12075', '12', '075', 'Levy', 5, 8),
    // Shares the metro's border but sits outside it: intersects, not a member.
    county('12041', '12', '041', 'Dixie', 5, 14),
  ],
};

const acsCounties = (rows) => [
  ['NAME', POP, 'state', 'county'],
  ...rows,
];

describe('binding to the right TIGERweb layers', () => {
  it('picks between identically-named layers by feature count', async () => {
    /**
     * The failure the second real run produced: twenty-one layers in
     * `Census2020/State_County` all named exactly "Counties". Their names, ids
     * and order say nothing about which carries whole counties at full detail,
     * so the discriminator has to be the data — about 3,143 rows.
     */
    const layers = await discoverLayers({ fetchImpl: fakeFetch(DISCOVERY) });
    // 85 is a generalised tier with 400 features and is skipped; 86 is the
    // first candidate with a country's worth of counties.
    expect(layers.counties.id).toBe(86);
    expect(layers.counties.features).toBe(3143);
    // And it records that it chose from several, so a probe does not read as
    // more certain than it is.
    expect(layers.counties.pickedFrom).toBe(3);
  });

  it('takes the FIRST plausible candidate, not the last, so probing stays cheap', async () => {
    // Twenty-one candidates would be twenty-one requests if every one were
    // counted. Ids 86 and 88 are both plausible; the lower wins and the search
    // stops there.
    const impl = fakeFetch(DISCOVERY);
    await discoverLayers({ fetchImpl: impl });
    expect(impl.calls.some((u) => u.includes('/88/query'))).toBe(false);
  });

  it('refuses when no candidate holds a plausible number of features', async () => {
    // Every "Counties" layer returning 400 rows means none of them is the
    // counties layer, whatever they are called.
    const routes = {
      ...DISCOVERY,
      '/86/query?where=1%3D1&returnCountOnly=true': { count: 400 },
      '/88/query?where=1%3D1&returnCountOnly=true': { count: 400 },
    };
    await expect(discoverLayers({ fetchImpl: fakeFetch(routes) }))
      .rejects.toMatchObject({ code: 'layer_not_found' });
    // …and says what the counts were, which is the only way to pick a band.
    await expect(discoverLayers({ fetchImpl: fakeFetch(routes) }))
      .rejects.toThrow(/plausible feature count/);
  });

  it('bands each geography so no other layer can satisfy it', () => {
    // 3,143 counties and ~935 metro/micropolitan areas. The bands have to be
    // wide enough for vintage drift and narrow enough that states (56),
    // places (~30,000) or tracts (~85,000) cannot slip in.
    expect(EXPECTED_FEATURES.counties.min).toBeGreaterThan(56);
    expect(EXPECTED_FEATURES.counties.max).toBeLessThan(30000);
    expect(EXPECTED_FEATURES.cbsa.max).toBeLessThan(EXPECTED_FEATURES.counties.min);
    for (const e of Object.values(EXPECTED_FEATURES)) {
      expect(e.about).toBeGreaterThanOrEqual(e.min);
      expect(e.about).toBeLessThanOrEqual(e.max);
    }
  });

  it('caps how many candidates it will count', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'Counties' }));
    const impl = fakeFetch({ '/query?where=1%3D1&returnCountOnly=true': { count: 7 } });
    const r = await chooseByFeatureCount('https://x/MapServer', many,
      EXPECTED_FEATURES.counties, { fetchImpl: impl });
    expect(r).toBeNull();
    expect(impl.calls.length).toBeLessThanOrEqual(MAX_LAYERS_COUNTED);
  });

  it('prefers a current service over one pinned to a census year', async () => {
    // A year-stamped service is a snapshot of THAT census's boundaries.
    // Counties barely move; CBSA delineations do, and the whole point is to use
    // the latest county list.
    const services = await listServices({
      fetchImpl: fakeFetch({
        'arcgis/rest/services?f=json': { folders: [], services: [
          { name: 'Census2020/State_County', type: 'MapServer' },
          { name: 'TIGERweb/State_County', type: 'MapServer' },
        ] },
      }),
    });
    expect(services[0].name).toBe('TIGERweb/State_County');
  });

  it('finds the two layers even when they live in different services', async () => {
    // The failure the first real run produced: tigerWMS_Current has neither.
    // Counties are in State_County and CBSAs in a Generalized service, so a
    // search scoped to one MapServer finds nothing however good its patterns.
    const layers = await discoverLayers({ fetchImpl: fakeFetch(DISCOVERY) });
    expect(layers.counties.id).toBe(86);
    expect(layers.counties.service).toMatch(/State_County/);
    expect(layers.cbsa.id).toBe(5);
    expect(layers.cbsa.service).toMatch(/Generalized_ACS2023/);
  });

  it('matches the names TIGERweb actually uses, and only those', () => {
    /**
     * The third thing the real run disproved. The CBSA pattern was written
     * from the ACS API's name for the geography — "metropolitan statistical
     * area/micropolitan statistical area" — and no TIGERweb layer is called
     * that, so it matched nothing across thirty services.
     *
     * Every name below came back from the live probe.
     */
    const matches = (key, name) => LAYER_PATTERNS[key].some((p) => p.test(name));

    expect(matches('cbsa', 'Metropolitan and Micropolitan Statistical Areas')).toBe(true);
    expect(matches('cbsa', 'Metropolitan Statistical Areas')).toBe(true);
    expect(matches('counties', 'Counties')).toBe(true);

    for (const wrong of [
      // Micropolitan areas are real CBSAs and contain none of these markets.
      // It also passes any feature-count band, so only the pattern stops it.
      'Micropolitan Statistical Areas',
      // Generalisation tiers: the same areas drawn for small-scale maps, with
      // borders moved by miles — enough to put a centroid the wrong side.
      'Metropolitan Statistical Areas 500K', 'Metropolitan Statistical Areas 5M',
      'Counties 500K', 'Counties 5M', 'Counties 20M',
      // Different geographies that read like the right one.
      'Metropolitan Divisions', 'Combined Statistical Areas',
      'Metropolitan New England City and Town Areas', 'County Subdivisions',
      'States', 'Principal Cities', 'Labels',
    ]) {
      expect(matches('cbsa', wrong), `cbsa should not match ${wrong}`).toBe(false);
      expect(matches('counties', wrong), `counties should not match ${wrong}`).toBe(false);
    }
  });

  it('prefers the combined CBSA layer over a metros-only one', async () => {
    // Both are acceptable and both are present; the combined layer also
    // carries micropolitan areas, which is what a future market needs.
    const layers = await discoverLayers({ fetchImpl: fakeFetch(DISCOVERY) });
    expect(layers.cbsa.name).toBe('Metropolitan and Micropolitan Statistical Areas');
    expect(layers.cbsa.features).toBe(935);
  });

  it('never binds Counties to County Subdivisions', () => {
    // A looser pattern matches both, and subdivisions are townships — dozens
    // of sub-county pieces whose centroids all sit inside the metro. It is the
    // layer tigerWMS_Current actually offers, so this is the live hazard.
    const matches = (name) => LAYER_PATTERNS.counties.some((p) => p.test(name));
    expect(matches('County Subdivisions')).toBe(false);
    expect(matches('Counties')).toBe(true);
  });

  it('never binds to a Labels layer, in any service', async () => {
    const layers = await discoverLayers({ fetchImpl: fakeFetch(DISCOVERY) });
    expect(layers.cbsa.name).not.toMatch(/label/i);
    expect(layers.counties.name).not.toMatch(/label/i);
    expect(layers.counties.service).not.toMatch(/\/Labels\//);
  });

  it('opens the likeliest services first and stays inside the cap', async () => {
    const impl = fakeFetch(DISCOVERY);
    await discoverLayers({ fetchImpl: impl });
    const opened = impl.calls.filter((u) => u.includes('/MapServer?f=json'));
    // State_County scores highest, so it is opened before the sub-county
    // service that carries neither layer.
    expect(opened[0]).toMatch(/State_County/);
    expect(opened.length).toBeLessThanOrEqual(MAX_SERVICES_PROBED);
  });

  it('stops opening services once both layers are bound', async () => {
    // With both layers in the first service there is nothing left to look for,
    // and the remaining three must not be opened.
    const impl = fakeFetch({
      ...countRoutes,
      'arcgis/rest/services?f=json': DIRECTORY,
      'arcgis/rest/services/TIGERweb?f=json': FOLDER,
      'State_County/MapServer?f=json': {
        layers: [...STATE_COUNTY_SERVICE.layers, ...GENERALIZED_SERVICE.layers],
      },
      ...countRoutes,
    });
    const layers = await discoverLayers({ fetchImpl: impl });
    expect(layers.counties.service).toMatch(/State_County/);
    expect(layers.cbsa.service).toMatch(/State_County/);
    expect(impl.calls.filter((u) => u.includes('/MapServer?f=json'))).toHaveLength(1);
  });

  it('keeps going when one service will not answer', async () => {
    // A single unreachable MapServer must not end the search; the next one may
    // hold both layers.
    const routes = { ...DISCOVERY };
    delete routes['State_County/MapServer?f=json'];
    const withFailure = {
      ...routes,
      'State_County/MapServer?f=json': new Error('gateway timeout'),
      'Generalized_ACS2023/MapServer?f=json': {
        layers: [...GENERALIZED_SERVICE.layers, { id: 86, name: 'Counties' }],
      },
    };
    const layers = await discoverLayers({ fetchImpl: fakeFetch(withFailure) });
    expect(layers.counties.service).toMatch(/Generalized_ACS2023/);
  });

  it('reports the services searched and the layers seen when it fails', async () => {
    // This is the message that diagnosed the first failure: without the list
    // of what WAS offered, "layer not found" is unactionable.
    const impl = fakeFetch({
      'arcgis/rest/services?f=json': DIRECTORY,
      'arcgis/rest/services/TIGERweb?f=json': {
        services: [{ name: 'TIGERweb/tigerWMS_Current', type: 'MapServer' }],
      },
      'tigerWMS_Current/MapServer?f=json': SUBCOUNTY_SERVICE,
    });
    await expect(discoverLayers({ fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'layer_not_found' });
    await expect(discoverLayers({ fetchImpl: impl })).rejects.toThrow(/County Subdivisions/);
    await expect(discoverLayers({ fetchImpl: impl })).rejects.toThrow(/tigerWMS_Current/);
  });

  it('resolves ambiguity by data rather than refusing it', async () => {
    // This used to throw `layer_ambiguous`, which was the right answer when
    // two identical names meant something had gone wrong. The real service has
    // twenty-one of them as a matter of course, so refusing would refuse
    // always. The counts settle it: id 2 holds a country's worth, id 1 does
    // not.
    const impl = fakeFetch({
      'arcgis/rest/services?f=json': { folders: [], services: [{ name: 'X', type: 'MapServer' }] },
      'X/MapServer?f=json': {
        layers: [
          { id: 1, name: 'Counties' },
          { id: 2, name: 'Counties' },
          { id: 3, name: 'Metropolitan and Micropolitan Statistical Areas' },
        ],
      },
      '/1/query?where=1%3D1&returnCountOnly=true': { count: 12 },
      '/2/query?where=1%3D1&returnCountOnly=true': { count: 3143 },
      '/3/query?where=1%3D1&returnCountOnly=true': { count: 935 },
    });
    const layers = await discoverLayers({ fetchImpl: impl });
    expect(layers.counties.id).toBe(2);
  });

  it('lists services from folders as well as the root', async () => {
    // TIGERweb keeps everything in a folder of its own name, so a listing that
    // reads only the root sees nothing at all.
    const services = await listServices({ fetchImpl: fakeFetch(DISCOVERY) });
    expect(services.map((s) => s.name)).toContain('TIGERweb/State_County');
    expect(services.every((s) => s.url.endsWith('/MapServer'))).toBe(true);
  });

  it('will not open an unbounded number of services', async () => {
    // A directory listing hundreds of MapServers must not become hundreds of
    // requests on every run.
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `S${i}`, type: 'MapServer' }));
    const routes = { 'arcgis/rest/services?f=json': { folders: [], services: many } };
    for (const s of many) routes[`${s.name}/MapServer?f=json`] = { layers: [{ id: 0, name: 'Blocks' }] };
    const impl = fakeFetch(routes);
    await expect(discoverLayers({ fetchImpl: impl })).rejects.toMatchObject({ code: 'layer_not_found' });
    expect(impl.calls.filter((u) => u.includes('/MapServer?f=json')).length)
      .toBeLessThanOrEqual(MAX_SERVICES_PROBED);
  });
});

describe('which counties are in the metro', () => {
  const routes = {
    ...DISCOVERY,
    'Generalized_ACS2023/MapServer/5/query': CBSA_POLYGON,
    'State_County/MapServer/86/query': COUNTIES,
  };

  it('takes the counties inside, and not the one over the border', async () => {
    // ArcGIS "intersects" includes a county that merely shares an edge. Left
    // in, Dixie's population would be added to Gainesville in both years —
    // which does not break growth, but does break the level.
    const r = await countiesInCbsa('23540', { fetchImpl: fakeFetch(routes) });
    expect(r.counties.map((c) => c.name)).toEqual(['Alachua', 'Levy']);
    expect(r.bordering).toBe(1);
  });

  it('carries the name TIGERweb gave, so a wrong GEOID is visible', async () => {
    const r = await countiesInCbsa('23540', { fetchImpl: fakeFetch(routes) });
    expect(r.cbsaName).toBe('Gainesville, FL Metro Area');
  });

  it('says so when no county centroid lands inside', async () => {
    // Every county bordering and none inside means the geometry or the
    // centroid fields are not what this expects — a silent empty set would
    // become a zero population.
    const r = { ...routes, 'State_County/MapServer/86/query': { features: [county('12041', '12', '041', 'Dixie', 5, 14)] } };
    await expect(countiesInCbsa('23540', { fetchImpl: fakeFetch(r) }))
      .rejects.toMatchObject({ code: 'no_counties_inside' });
  });

  it('says so when the CBSA GEOID is not in the layer', async () => {
    const r = { ...routes, 'Generalized_ACS2023/MapServer/5/query': { features: [] } };
    await expect(countiesInCbsa('99999', { fetchImpl: fakeFetch(r) }))
      .rejects.toMatchObject({ code: 'cbsa_not_found' });
  });

  it('is a CrosswalkError, so callers can tell it from a network failure', async () => {
    const r = { ...routes, 'Generalized_ACS2023/MapServer/5/query': { features: [] } };
    await expect(countiesInCbsa('99999', { fetchImpl: fakeFetch(r) }))
      .rejects.toBeInstanceOf(CrosswalkError);
  });
});

describe('growth over a fixed county set', () => {
  const geo = {
    ...DISCOVERY,
    'Generalized_ACS2023/MapServer/5/query': CBSA_POLYGON,
    'State_County/MapServer/86/query': COUNTIES,
  };

  it('undoes the Gainesville artifact, which is the reason this exists', async () => {
    /**
     * The real run reported +23.1% over five years, because Levy joined the
     * CBSA between the vintages. Over the FIXED set — Alachua and Levy in both
     * years — the same underlying data gives ordinary growth.
     *
     *   2017: 269,043 + 40,801 = 309,844
     *   2022: 278,468 + 42,915 = 321,383     +3.7% total, 0.73%/yr
     *
     * The whole-metro difference read 277,120 → 341,067 because the 2017 total
     * did not include Levy at all.
     */
    const impl = fakeFetch({
      ...geo,
      '/2017/acs/acs5': acsCounties([
        ['Alachua County, Florida', '269043', '12', '001'],
        ['Levy County, Florida', '40801', '12', '075'],
      ]),
      '/2022/acs/acs5': acsCounties([
        ['Alachua County, Florida', '278468', '12', '001'],
        ['Levy County, Florida', '42915', '12', '075'],
      ]),
    });

    const r = await growthOverFixedCounties('23540', { fetchImpl: impl });
    expect(r.method).toBe('fixed-county-set');
    expect(r.earlierTotal).toBe(309844);
    expect(r.latestTotal).toBe(321383);
    expect(r.totalChangePct).toBeCloseTo(3.72, 1);
    expect(r.popGrowth5y).toBeCloseTo(0.73, 1);
    // The number the old method produced, for contrast. Nothing in the fixed
    // set is anywhere near it.
    expect(r.popGrowth5y).toBeLessThan(4.24 / 2);
  });

  it('REFUSES rather than undercounting when a county is missing from a vintage', async () => {
    /**
     * Connecticut is the live case: the 2022 ACS replaced its eight counties
     * with nine planning regions on new FIPS. The current county list finds
     * nothing in 2017, and summing only what matched would drop whole counties
     * out of the earlier total — reporting a population collapse that never
     * happened, through the fix rather than the bug.
     */
    const impl = fakeFetch({
      ...geo,
      '/2017/acs/acs5': acsCounties([['Alachua County, Florida', '269043', '12', '001']]),
      '/2022/acs/acs5': acsCounties([
        ['Alachua County, Florida', '278468', '12', '001'],
        ['Levy County, Florida', '42915', '12', '075'],
      ]),
    });

    const r = await growthOverFixedCounties('23540', { fetchImpl: impl });
    expect(r.popGrowth5y).toBeNull();
    expect(r.refused).toBe('incomplete_county_coverage');
    expect(r.missing.from).toContain('Levy');
    expect(r.note).toMatch(/planning regions/i);
  });

  it('treats a suppressed county population as missing, not as zero', async () => {
    const impl = fakeFetch({
      ...geo,
      '/2017/acs/acs5': acsCounties([
        ['Alachua County, Florida', '269043', '12', '001'],
        ['Levy County, Florida', '-666666666', '12', '075'],
      ]),
      '/2022/acs/acs5': acsCounties([
        ['Alachua County, Florida', '278468', '12', '001'],
        ['Levy County, Florida', '42915', '12', '075'],
      ]),
    });
    const r = await growthOverFixedCounties('23540', { fetchImpl: impl });
    expect(r.popGrowth5y).toBeNull();
    expect(r.missing.from).toContain('Levy');
  });

  it('annualises, and refuses overlapping vintages', async () => {
    const impl = fakeFetch({
      ...geo,
      '/2017/acs/acs5': acsCounties([['Alachua County, Florida', '200000', '12', '001'],
        ['Levy County, Florida', '0', '12', '075']]),
      '/2022/acs/acs5': acsCounties([['Alachua County, Florida', '220000', '12', '001'],
        ['Levy County, Florida', '0', '12', '075']]),
    });
    const r = await growthOverFixedCounties('23540', { fetchImpl: impl });
    // 10% over five years is 1.92% a year, not 10.
    expect(r.popGrowth5y).toBeCloseTo(1.9245, 3);

    await expect(growthOverFixedCounties('23540',
      { fetchImpl: impl, vintages: { from: 2019, to: 2022 } })).rejects.toThrow(/overlap/i);
  });

  it('fetches each state once per vintage, not once per county', async () => {
    // A metro spans a handful of states and up to a dozen counties; per-county
    // calls would be ~5,000 requests across the table instead of ~80.
    const impl = fakeFetch({
      ...geo,
      '/2017/acs/acs5': acsCounties([['Alachua County, Florida', '269043', '12', '001'],
        ['Levy County, Florida', '40801', '12', '075']]),
      '/2022/acs/acs5': acsCounties([['Alachua County, Florida', '278468', '12', '001'],
        ['Levy County, Florida', '42915', '12', '075']]),
    });
    await growthOverFixedCounties('23540', { fetchImpl: impl });
    const acsCalls = impl.calls.filter((u) => u.includes('/acs/acs5'));
    expect(acsCalls).toHaveLength(2);
    for (const u of acsCalls) expect(u).toContain('for=county:*');
  });

  it('reuses a shared cache across metros in the same state', async () => {
    const impl = fakeFetch({
      ...geo,
      '/2017/acs/acs5': acsCounties([['Alachua County, Florida', '269043', '12', '001'],
        ['Levy County, Florida', '40801', '12', '075']]),
      '/2022/acs/acs5': acsCounties([['Alachua County, Florida', '278468', '12', '001'],
        ['Levy County, Florida', '42915', '12', '075']]),
    });
    const cache = new Map();
    await growthOverFixedCounties('23540', { fetchImpl: impl, cache });
    const afterFirst = impl.calls.filter((u) => u.includes('/acs/acs5')).length;
    await growthOverFixedCounties('23540', { fetchImpl: impl, cache });
    expect(impl.calls.filter((u) => u.includes('/acs/acs5'))).toHaveLength(afterFirst);
  });
});

describe('a metro that crosses state lines, which is the nationwide case', () => {
  /**
   * Nine of the thirty-six markets span more than one state — Chicago is
   * IL-IN-WI, Cincinnati is OH-KY-IN, Kansas City is MO-KS, Omaha is NE-IA,
   * St. Louis is MO-IL, Minneapolis is MN-WI. County populations come per
   * state, so a metro's set has to be assembled across several calls, and a
   * method that quietly used only the first state would undercount the metro
   * by whatever sits over the line — and undercount it in BOTH years, which
   * hides the error in the level and leaves the growth looking fine.
   */
  const TRI_STATE = {
    cbsa: {
      features: [{
        attributes: { GEOID: '16980', NAME: 'Chicago-Naperville-Elgin, IL-IN-WI Metro Area' },
        geometry: { rings: [[[0, 0], [0, 10], [30, 10], [30, 0], [0, 0]]] },
      }],
    },
    counties: {
      features: [
        county('17031', '17', '031', 'Cook', 5, 5),
        county('18089', '18', '089', 'Lake', 5, 15),
        county('55059', '55', '059', 'Kenosha', 5, 25),
      ],
    },
  };

  it('sums every state the metro reaches into, in both years', async () => {
    // Each state answers its own call; the fixture keys on the state FIPS in
    // the URL so a missed state shows up as a missing county, not as a silent
    // short sum.
    const f = fakeFetch({
      ...DISCOVERY,
      'Generalized_ACS2023/MapServer/5/query': TRI_STATE.cbsa,
      'State_County/MapServer/86/query': TRI_STATE.counties,
      '/2017/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:17': acsCounties([['Cook County, Illinois', '5223719', '17', '031']]),
      '/2017/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:18': acsCounties([['Lake County, Indiana', '487865', '18', '089']]),
      '/2017/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:55': acsCounties([['Kenosha County, Wisconsin', '168330', '55', '059']]),
      '/2022/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:17': acsCounties([['Cook County, Illinois', '5173146', '17', '031']]),
      '/2022/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:18': acsCounties([['Lake County, Indiana', '498700', '18', '089']]),
      '/2022/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:55': acsCounties([['Kenosha County, Wisconsin', '169151', '55', '059']]),
    });

    const r = await growthOverFixedCounties('16980', { fetchImpl: f });
    expect(r.countyCount).toBe(3);
    expect(r.earlierTotal).toBe(5223719 + 487865 + 168330);
    expect(r.latestTotal).toBe(5173146 + 498700 + 169151);

    // Three states, two vintages: six calls, not three and not eighteen.
    const acs = f.calls.filter((u) => u.includes('/acs/acs5'));
    expect(acs).toHaveLength(6);
    for (const st of ['17', '18', '55']) {
      expect(acs.filter((u) => u.includes(`in=state:${st}`))).toHaveLength(2);
    }
  });

  it('refuses when one state is missing from a vintage, rather than short-summing', async () => {
    // The dangerous shape: two states answer, one does not. A sum over what
    // came back is a real-looking number about two thirds of a metro.
    const f = fakeFetch({
      ...DISCOVERY,
      'Generalized_ACS2023/MapServer/5/query': TRI_STATE.cbsa,
      'State_County/MapServer/86/query': TRI_STATE.counties,
      '/2017/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:17': acsCounties([['Cook County, Illinois', '5223719', '17', '031']]),
      '/2017/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:18': acsCounties([['Lake County, Indiana', '487865', '18', '089']]),
      '/2017/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:55': acsCounties([]),
      '/2022/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:17': acsCounties([['Cook County, Illinois', '5173146', '17', '031']]),
      '/2022/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:18': acsCounties([['Lake County, Indiana', '498700', '18', '089']]),
      '/2022/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:55': acsCounties([['Kenosha County, Wisconsin', '169151', '55', '059']]),
    });

    const r = await growthOverFixedCounties('16980', { fetchImpl: f });
    expect(r.popGrowth5y).toBeNull();
    expect(r.refused).toBe('incomplete_county_coverage');
    expect(r.missing.from).toContain('Kenosha');
  });
});

describe('the point-in-polygon test the membership rests on', () => {
  const square = [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]];

  it('separates inside from outside', () => {
    expect(pointInRings(5, 5, square)).toBe(true);
    expect(pointInRings(15, 5, square)).toBe(false);
    expect(pointInRings(-1, 5, square)).toBe(false);
  });

  it('handles a hole, because Esri encodes them as extra rings', () => {
    const donut = [square[0], [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]]];
    expect(pointInRings(5, 5, donut)).toBe(false);
    expect(pointInRings(1, 5, donut)).toBe(true);
  });

  it('counts a vertex on the ray once, not twice', () => {
    // A ray leaving a point at the same latitude as a vertex crosses two edges
    // meeting there. Counted twice, the parity flips back and an interior
    // point reads as outside.
    const diamond = [[[0, 5], [5, 10], [10, 5], [5, 0], [0, 5]]];
    expect(pointInRings(5, 5, diamond)).toBe(true);
    expect(pointInRings(-5, 5, diamond)).toBe(false);
  });

  it('ignores a horizontal boundary edge instead of counting along it', () => {
    /**
     * The case that separates `yi > y` from `yi >= y`, and not an exotic one:
     * county lines follow lines of latitude across most of the Midwest, so a
     * metro boundary lying flat at exactly a county centroid's latitude is
     * ordinary. Under `>=`, every point below a flat top reads as inside — the
     * horizontal edge gets counted as a crossing and the whole row of counties
     * south of the line joins the metro.
     *
     * Found by running the two rules against candidate polygons rather than by
     * reasoning about them: the first mutant written for this survived, because
     * a diamond does not distinguish them.
     */
    const flatTop = [[[0, 0], [0, 5], [10, 5], [10, 0], [0, 0]]];
    for (const x of [1, 2, 4, 6, 9]) {
      expect(pointInRings(x, 5, flatTop), `x=${x} on the boundary`).toBe(false);
    }
    // Genuinely inside is still inside.
    expect(pointInRings(5, 2, flatTop)).toBe(true);

    // And a step, where only part of the boundary is flat at that latitude.
    const step = [[[0, 0], [0, 10], [5, 10], [5, 5], [10, 5], [10, 0], [0, 0]]];
    expect(pointInRings(2, 5, step)).toBe(true);
    expect(pointInRings(7, 5, step)).toBe(false);
  });
});

describe('a lone name match still has to prove itself', () => {
  it('rejects a single "Counties" layer that does not hold counties', async () => {
    // Skipping the count check when only one layer matched was a hole: the
    // name says what a layer is MEANT to be, and only the count says what it
    // has. A service offering one "Counties" layer of four hundred features
    // would have been accepted on its name alone.
    const impl = fakeFetch({
      'arcgis/rest/services?f=json': { folders: [], services: [{ name: 'X', type: 'MapServer' }] },
      'X/MapServer?f=json': {
        layers: [
          { id: 1, name: 'Counties' },
          { id: 2, name: 'Metropolitan and Micropolitan Statistical Areas' },
        ],
      },
      '/1/query?where=1%3D1&returnCountOnly=true': { count: 400 },
      '/2/query?where=1%3D1&returnCountOnly=true': { count: 935 },
    });
    await expect(discoverLayers({ fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'layer_not_found' });
  });

  it('accepts it once the count is right, and records the count', async () => {
    const impl = fakeFetch({
      'arcgis/rest/services?f=json': { folders: [], services: [{ name: 'X', type: 'MapServer' }] },
      'X/MapServer?f=json': {
        layers: [
          { id: 1, name: 'Counties' },
          { id: 2, name: 'Metropolitan and Micropolitan Statistical Areas' },
        ],
      },
      '/1/query?where=1%3D1&returnCountOnly=true': { count: 3143 },
      '/2/query?where=1%3D1&returnCountOnly=true': { count: 935 },
    });
    const layers = await discoverLayers({ fetchImpl: impl });
    expect(layers.counties.features).toBe(3143);
    expect(layers.cbsa.features).toBe(935);
  });
});

describe('the fallbacks, which only fire when the preferred thing is absent', () => {
  it('falls back to a metros-only layer when the combined one is not offered', async () => {
    // Not every service carries "Metropolitan and Micropolitan Statistical
    // Areas". A metros-only layer holds every market in this table, so it is
    // an acceptable second choice — but only a second choice, and only if the
    // pattern list is actually tried past its first entry.
    const impl = fakeFetch({
      'arcgis/rest/services?f=json': { folders: [], services: [{ name: 'TIGERweb/CBSA', type: 'MapServer' }] },
      'TIGERweb/CBSA/MapServer?f=json': {
        layers: [
          { id: 1, name: 'Counties' },
          { id: 2, name: 'Metropolitan Statistical Areas' },
          { id: 3, name: 'Micropolitan Statistical Areas' },
        ],
      },
      '/1/query?where=1%3D1&returnCountOnly=true': { count: 3143 },
      '/2/query?where=1%3D1&returnCountOnly=true': { count: 393 },
      '/3/query?where=1%3D1&returnCountOnly=true': { count: 542 },
    });
    const layers = await discoverLayers({ fetchImpl: impl });
    expect(layers.cbsa.name).toBe('Metropolitan Statistical Areas');
    expect(layers.cbsa.features).toBe(393);
  });

  it('prefers the canonical TIGERweb service over another scoring the same', async () => {
    // Econ/CBSA is the Economic Census cut of the same geography and scores
    // identically on the CBSA hint. Alphabetically Econ wins, which is not a
    // reason to pick it.
    const services = await listServices({
      fetchImpl: fakeFetch({
        'arcgis/rest/services?f=json': {
          folders: [],
          services: [
            { name: 'Econ/CBSA', type: 'MapServer' },
            { name: 'TIGERweb/CBSA', type: 'MapServer' },
            { name: 'Generalized_ACS2025/CBSA', type: 'MapServer' },
          ],
        },
      }),
    });
    expect(services[0].name).toBe('TIGERweb/CBSA');
    // And the year-stamped one ranks below both.
    expect(services[services.length - 1].name).toBe('Generalized_ACS2025/CBSA');
  });
});
