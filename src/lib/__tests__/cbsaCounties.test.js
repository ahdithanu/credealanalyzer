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

/** The service root's layer list, as TIGERweb really shapes it. */
const SERVICE_ROOT = {
  layers: [
    { id: 4, name: 'Metropolitan Statistical Area/Micropolitan Statistical Area Labels' },
    { id: 5, name: 'Metropolitan Statistical Area/Micropolitan Statistical Area' },
    { id: 82, name: 'County Subdivisions' },
    { id: 86, name: 'Counties' },
    { id: 87, name: 'Counties Labels' },
  ],
};

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
  it('finds counties and CBSAs by name, not by a hardcoded id', async () => {
    // TIGERweb renumbers layers between releases, and a stale id does not
    // error — it returns a different geography with the same field names.
    const layers = await discoverLayers({ fetchImpl: fakeFetch({ MapServer: SERVICE_ROOT }) });
    expect(layers.counties.id).toBe(86);
    expect(layers.cbsa.id).toBe(5);
  });

  it('never binds Counties to County Subdivisions', () => {
    // A looser pattern matches both, and subdivisions are townships — which
    // would return dozens of sub-county pieces whose centroids all sit inside
    // the metro, summing populations that double-count nothing but mean
    // nothing either.
    expect(LAYER_PATTERNS.counties.test('County Subdivisions')).toBe(false);
    expect(LAYER_PATTERNS.counties.test('Counties')).toBe(true);
  });

  it('never binds to a Labels layer', async () => {
    // Label layers carry annotation geometry, not boundaries.
    const layers = await discoverLayers({ fetchImpl: fakeFetch({ MapServer: SERVICE_ROOT }) });
    expect(layers.cbsa.name).not.toMatch(/label/i);
    expect(layers.counties.name).not.toMatch(/label/i);
  });

  it('reports what the service offered when a layer is gone', async () => {
    const impl = fakeFetch({ MapServer: { layers: [{ id: 1, name: 'Blocks' }] } });
    await expect(discoverLayers({ fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'layer_not_found' });
    // The failure has to name what WAS there, or the next step is guesswork.
    await expect(discoverLayers({ fetchImpl: impl })).rejects.toThrow(/Blocks/);
  });

  it('refuses an ambiguous match rather than taking the first', async () => {
    const impl = fakeFetch({
      MapServer: { layers: [{ id: 1, name: 'Counties' }, { id: 2, name: 'Counties' }] },
    });
    await expect(discoverLayers({ fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'layer_ambiguous' });
  });
});

describe('which counties are in the metro', () => {
  const routes = {
    'MapServer?f=json': SERVICE_ROOT,
    'MapServer/5/query': CBSA_POLYGON,
    'MapServer/86/query': COUNTIES,
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
    const r = { ...routes, 'MapServer/86/query': { features: [county('12041', '12', '041', 'Dixie', 5, 14)] } };
    await expect(countiesInCbsa('23540', { fetchImpl: fakeFetch(r) }))
      .rejects.toMatchObject({ code: 'no_counties_inside' });
  });

  it('says so when the CBSA GEOID is not in the layer', async () => {
    const r = { ...routes, 'MapServer/5/query': { features: [] } };
    await expect(countiesInCbsa('99999', { fetchImpl: fakeFetch(r) }))
      .rejects.toMatchObject({ code: 'cbsa_not_found' });
  });

  it('is a CrosswalkError, so callers can tell it from a network failure', async () => {
    const r = { ...routes, 'MapServer/5/query': { features: [] } };
    await expect(countiesInCbsa('99999', { fetchImpl: fakeFetch(r) }))
      .rejects.toBeInstanceOf(CrosswalkError);
  });
});

describe('growth over a fixed county set', () => {
  const geo = {
    'MapServer?f=json': SERVICE_ROOT,
    'MapServer/5/query': CBSA_POLYGON,
    'MapServer/86/query': COUNTIES,
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
    layers: SERVICE_ROOT,
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
      'MapServer?f=json': TRI_STATE.layers,
      'MapServer/5/query': TRI_STATE.cbsa,
      'MapServer/86/query': TRI_STATE.counties,
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
      'MapServer?f=json': TRI_STATE.layers,
      'MapServer/5/query': TRI_STATE.cbsa,
      'MapServer/86/query': TRI_STATE.counties,
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
