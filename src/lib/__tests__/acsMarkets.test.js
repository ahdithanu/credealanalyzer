/**
 * Sourcing the market table from the Census.
 *
 * Not one line of this has made a live call — api.census.gov is off the egress
 * allowlist where it was written — so everything except the socket is tested
 * against recorded ACS response shapes, and the socket is what
 * `npm run markets` exists to verify. See src/lib/ingest/http.js.
 */

import {
  cbsaFigures, sourceMarket, CBSA, DEFAULT_VINTAGES, SOURCEABLE_FIELDS, renderSourcedModule,
  ADVISORY_FIELDS, IMPLAUSIBLE_5Y_CHANGE_PCT,
} from '../ingest/acsMarkets';
import { markets, MARKET_DATA_FIELDS } from '../markets';

const POP = 'B01003_001E';
const HHI = 'B19013_001E';
const GEO = 'metropolitan statistical area/micropolitan statistical area';

/** An ACS answer: a header row, then data rows. Not objects. */
const acs = (header, row) => [header, row];

/** A fetch that answers each URL from a table, and records what was asked. */
function recorder(byMatch) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const hit = Object.entries(byMatch).find(([fragment]) => url.includes(fragment));
    if (!hit) throw new Error(`unexpected request: ${url}`);
    // An empty string is a 204: the query matched nothing.
    if (hit[1] === '') return { ok: true, status: 204, text: async () => '' };
    // A raw string is served as-is, so an HTML error page can be a fixture.
    const body = typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]);
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetchImpl, calls };
}

describe('the code registry lines up with the market table', () => {
  it('every market has a CBSA code and every code has a market', () => {
    // A market missing from CBSA is a market that silently never gets sourced,
    // and a code with no market is a stale entry pointing at a record that was
    // renamed or removed.
    expect(Object.keys(CBSA).sort()).toEqual(markets.map((m) => m.key).sort());
  });

  it('only claims the fields it can actually fill', () => {
    for (const f of SOURCEABLE_FIELDS) expect(MARKET_DATA_FIELDS).toContain(f);
    // popGrowth5y is on BOTH lists, which is the design rather than a slip:
    // written when it comes from the fixed county set, shown-only when it
    // falls back to the whole-metro difference. The METHOD decides, not the
    // field — so what must hold is that every advisory name is a real field.
    for (const f of ADVISORY_FIELDS) expect(MARKET_DATA_FIELDS).toContain(f);
    expect(ADVISORY_FIELDS).toContain('popGrowth5y');
    // Five of the nine have no free source at all. If this list ever grows to
    // cover them, it is because a feed was bought, not because the names were
    // added here.
    for (const f of ['supplyPipeline', 'rentGrowth', 'marketCapRate', 'trafficCount']) {
      expect(SOURCEABLE_FIELDS).not.toContain(f);
    }
  });
});

describe('reading one vintage', () => {
  it('locates columns by name, not by the order they were requested in', () => {
    // ACS does not promise to echo the requested order, and the geography
    // column arrives last regardless. Reading row[1] as the population is
    // right until the day it is the income.
    const { fetchImpl } = recorder({
      '/2022/acs/acs5': acs(
        [HHI, 'NAME', GEO, POP],
        ['76208', 'Columbus, OH Metro Area', '18140', '2151017'],
      ),
    });

    return cbsaFigures('18140', { vintage: 2022 }, { fetchImpl }).then((r) => {
      expect(r.name).toBe('Columbus, OH Metro Area');
      expect(r[POP]).toBe(2151017);
      expect(r[HHI]).toBe(76208);
    });
  });

  it('reads a suppressed value as unknown, not as a negative population', () => {
    // ACS marks suppression with large negative sentinels. -666666666 people is
    // how a metro ends up at the bottom of every percentile in the scorer.
    const { fetchImpl } = recorder({
      '/2022/acs/acs5': acs(['NAME', POP, HHI, GEO], ['Somewhere Metro Area', '2151017', '-666666666', '18140']),
    });

    return cbsaFigures('18140', { vintage: 2022 }, { fetchImpl }).then((r) => {
      expect(r[POP]).toBe(2151017);
      expect(r[HHI]).toBeNull();
    });
  });

  it('returns null for an empty answer rather than throwing', () => {
    const { fetchImpl } = recorder({ '/2022/acs/acs5': [['NAME', POP, GEO]] });
    return cbsaFigures('99999', { vintage: 2022 }, { fetchImpl })
      .then((r) => expect(r).toBeNull());
  });
});

describe('sourcing one market', () => {
  // countyGrowth: false on these — they pin what the WHOLE-METRO difference
  // does, which is the fallback path. The county route has its own suite in
  // cbsaCounties.test.js with TIGERweb fixtures.
  const twoVintages = (latestPop, earlierPop, hhi = '76208') => recorder({
    '/2022/acs/acs5': acs(['NAME', POP, HHI, GEO], ['Columbus, OH Metro Area', latestPop, hhi, '18140']),
    '/2017/acs/acs5': acs(['NAME', POP, GEO], ['Columbus, OH Metro Area', earlierPop, '18140']),
  });

  it('annualises the growth instead of reporting the whole five years', () => {
    // 2,000,000 → 2,200,000 is 10% over five years and 1.92% a year. The field
    // is documented as a CAGR and is percentile-ranked against markets whose
    // seed values are annual, so a total would put every sourced market at the
    // top of the growth feature — an artefact of the unit, not of the place.
    const { fetchImpl } = twoVintages('2200000', '2000000');

    return sourceMarket('columbus-oh', { fetchImpl, countyGrowth: false }).then((r) => {
      expect(r.advisory.popGrowth5y).toBeCloseTo(1.9245, 3);
      expect(r.advisory.totalChangePct).toBeCloseTo(10, 6);
    });
  });

  it('NEVER writes the growth, however sane it looks', () => {
    // The whole point. A plausible growth rate is not evidence the two
    // vintages covered the same counties — it is evidence that if they did
    // not, the artifact happened to be small. Written, there is no way to tell
    // those apart afterwards.
    const { fetchImpl } = twoVintages('2100000', '2000000');
    return sourceMarket('columbus-oh', { fetchImpl, countyGrowth: false }).then((r) => {
      expect(r.fields).not.toHaveProperty('popGrowth5y');
      expect(r.advisory.written).toBe(false);
      expect(r.advisory.implausible).toBe(false);
      // The levels ARE written: they are read off one vintage and no
      // comparison is involved.
      expect(r.fields.population).toBe(2100000);
      expect(r.fields.medianHHI).toBe(76208);
    });
  });

  it('flags a change too big to be people, with Gainesville as the case', () => {
    // The real run: 277,120 → 341,067. Gainesville did not add 64,000 people
    // in five years; Levy and Gilchrist counties joined the CBSA. Written,
    // 4.24%/yr would have ranked Gainesville above Austin on population growth
    // across all thirty-six markets.
    const { fetchImpl } = twoVintages('341067', '277120');
    return sourceMarket('gainesville-fl', { fetchImpl, cbsa: '23540', countyGrowth: false }).then((r) => {
      expect(r.advisory.totalChangePct).toBeGreaterThan(IMPLAUSIBLE_5Y_CHANGE_PCT);
      expect(r.advisory.implausible).toBe(true);
      expect(r.fields).not.toHaveProperty('popGrowth5y');
    });
  });

  it('is two-sided, so a metro that shrank can be flagged too', () => {
    const { fetchImpl } = twoVintages('1000000', '1200000');
    return sourceMarket('cleveland-oh', { fetchImpl, cbsa: '17460', countyGrowth: false }).then((r) => {
      expect(r.advisory.totalChangePct).toBeLessThan(0);
      expect(r.advisory.implausible).toBe(true);
    });
  });

  it('MISSES Corpus Christi, which is why nothing depends on the flag', () => {
    // 450,276 → 422,187 is Aransas County leaving the CBSA — a real boundary
    // change — and at -6.2% it is under the threshold. No threshold separates
    // a delineation change from a genuinely shrinking metro, because both are
    // a real metro getting smaller on paper.
    //
    // That is the whole argument for refusing to write growth UNCONDITIONALLY
    // rather than writing it when the flag stays quiet. The flag is a hint for
    // the reader; it is not a gate, and this pins that it cannot become one.
    const { fetchImpl } = twoVintages('422187', '450276');
    return sourceMarket('corpus-christi-tx', { fetchImpl, cbsa: '18580', countyGrowth: false }).then((r) => {
      expect(r.advisory.implausible).toBe(false);
      expect(r.fields).not.toHaveProperty('popGrowth5y');
      expect(r.advisory.written).toBe(false);
    });
  });

  it('does not cry wolf on ordinary growth', () => {
    // Houston, from the same run: 6,636,731 → 7,142,603, +7.6% over five
    // years. Real, fast, and under the threshold. A guard that fires on this
    // is a guard nobody reads.
    const { fetchImpl } = twoVintages('7142603', '6636731');
    return sourceMarket('houston-tx', { fetchImpl, cbsa: '26420', countyGrowth: false }).then((r) => {
      expect(r.advisory.implausible).toBe(false);
    });
  });

  it('treats a CBSA missing from the earlier vintage as uncomparable, not broken', () => {
    // Dayton, from the real run: ACS 2017 answered 204 for CBSA 19430. An
    // empty body is an ANSWER — the metro was not delineated that way then —
    // and it used to surface as "returned 204 but not JSON", which sends you
    // to check a URL that is correct.
    const { fetchImpl } = recorder({
      '/2022/acs/acs5': acs(['NAME', POP, HHI, GEO], ['Dayton-Kettering, OH Metro Area', '814049', '65000', '19430']),
      '/2017/acs/acs5': '',
    });
    return sourceMarket('dayton-oh', { fetchImpl, cbsa: '19430', countyGrowth: false }).then((r) => {
      // The levels still land. Only the comparison is impossible.
      expect(r.fields.population).toBe(814049);
      expect(r.advisory).toBeNull();
      expect(r.notes.join(' ')).toMatch(/did not exist in ACS 2017/i);
    });
  });

  it('returns the name the Census gave, which is the only check on the code', () => {
    // A wrong CBSA code does not error. It answers with a real metro that is
    // not yours, and the name beside the city is what makes that visible.
    const { fetchImpl } = twoVintages('2200000', '2000000');
    return sourceMarket('columbus-oh', { fetchImpl })
      .then((r) => expect(r.cbsaName).toBe('Columbus, OH Metro Area'));
  });

  it('sets the population basis to metro, because that is what a CBSA is', () => {
    const { fetchImpl } = twoVintages('2200000', '2000000');
    return sourceMarket('plano-tx', { fetchImpl, cbsa: '19100', countyGrowth: false })
      .then((r) => expect(r.fields.populationBasis).toBe('metro'));
  });

  it('notes a suppressed income and writes no value for it', () => {
    // A missing median income must not arrive as 0, which reads as the poorest
    // market in the peer set rather than as an unknown.
    const { fetchImpl } = twoVintages('2200000', '2000000', '-666666666');
    return sourceMarket('columbus-oh', { fetchImpl, countyGrowth: false }).then((r) => {
      expect(r.fields).not.toHaveProperty('medianHHI');
      expect(r.notes.join(' ')).toMatch(/median household income/i);
    });
  });

  it('computes no growth at all when the earlier vintage is missing', () => {
    const { fetchImpl } = recorder({
      '/2022/acs/acs5': acs(['NAME', POP, HHI, GEO], ['Columbus, OH Metro Area', '2200000', '76208', '18140']),
      '/2017/acs/acs5': [['NAME', POP, GEO]],
    });
    return sourceMarket('columbus-oh', { fetchImpl, countyGrowth: false }).then((r) => {
      expect(r.fields).not.toHaveProperty('popGrowth5y');
      expect(r.fields.population).toBe(2200000);
      expect(r.notes.join(' ')).toMatch(/growth not computed/i);
    });
  });

  it('lets a REAL failure on the earlier vintage through, not as "did not exist"', () => {
    // Only 204 means the metro was not delineated that way. A 500, a rejected
    // key or a moved endpoint must not be laundered into a comparability note
    // — the script stops the whole run on missing_key, and it can only do that
    // if the error survives the growth lookup.
    const cases = [
      ['<html><head><title>Invalid Key</title></head></html>', 'invalid_key'],
      ['<html><head><title>Missing Key</title></head></html>', 'missing_key'],
    ];
    return Promise.all(cases.map(([body, code]) => {
      const { fetchImpl } = recorder({
        '/2022/acs/acs5': acs(['NAME', POP, HHI, GEO], ['Columbus, OH Metro Area', '2137223', '76541', '18140']),
        '/2017/acs/acs5': body,
      });
      return expect(sourceMarket('columbus-oh', { fetchImpl, countyGrowth: false }))
        .rejects.toMatchObject({ code });
    }));
  });

  it('refuses a pair of overlapping vintages', () => {
    // 2019 (2015-2019) against 2022 (2018-2022) shares two years, and the
    // Census Bureau says plainly not to difference those.
    const { fetchImpl } = twoVintages('2200000', '2000000');
    return expect(sourceMarket('columbus-oh', { fetchImpl, countyGrowth: false, vintages: { from: 2019, to: 2022 } }))
      .rejects.toThrow(/overlap/i);
  });

  it('says so, rather than throwing, for a market with no code', () => {
    return sourceMarket('atlantis-xx', { fetchImpl: async () => { throw new Error('should not be called'); } })
      .then((r) => {
        expect(r.fields).toEqual({});
        expect(r.notes.join(' ')).toMatch(/no CBSA code/i);
      });
  });

  it('uses the configured non-overlapping vintages by default', () => {
    expect(DEFAULT_VINTAGES.to - DEFAULT_VINTAGES.from).toBeGreaterThanOrEqual(5);
    const { fetchImpl, calls } = twoVintages('2200000', '2000000');
    return sourceMarket('columbus-oh', { fetchImpl, countyGrowth: false }).then(() => {
      expect(calls.some((u) => u.includes(`/${DEFAULT_VINTAGES.to}/acs/acs5`))).toBe(true);
      expect(calls.some((u) => u.includes(`/${DEFAULT_VINTAGES.from}/acs/acs5`))).toBe(true);
    });
  });
});

describe('the generated overlay module', () => {
  const entry = {
    cbsa: '18140',
    cbsaName: 'Columbus, OH Metro Area',
    asOf: 'ACS 5-year 2022',
    fields: { population: 2151017, medianHHI: 76208, popGrowth5y: 0.9412, populationBasis: 'metro' },
  };

  /** Import the rendered text as a module, the way the app will. */
  const load = async (text) => {
    const url = `data:text/javascript;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
    return import(/* @vite-ignore */ url);
  };

  it('parses, and round-trips what was written into it', async () => {
    // The script that writes this file cannot run where it was written, so a
    // generated file that does not parse would be discovered by the app failing
    // to start — in whatever environment finally had network access.
    const mod = await load(renderSourcedModule({ 'columbus-oh': entry }, { writtenOn: '2026-01-01' }));
    expect(mod.SOURCED['columbus-oh']).toEqual(entry);
  });

  it('is an empty object, not undefined, when nothing was sourced', async () => {
    // markets.js does SOURCED[key] on every record at import. An overlay that
    // renders `undefined` takes the whole app down rather than degrading.
    const mod = await load(renderSourcedModule({}, { writtenOn: '2026-01-01' }));
    expect(mod.SOURCED).toEqual({});
  });

  it('records the vintages it was built from', async () => {
    const text = renderSourcedModule({}, { vintages: { from: 2017, to: 2022 }, writtenOn: '2026-01-01' });
    expect(text).toContain('2017 and 2022');
    expect(text).toContain('2026-01-01');
    expect(text).toMatch(/do not hand-edit/i);
  });

  it('survives a market name carrying an apostrophe or a quote', async () => {
    // Census place names include "Lee's Summit" and similar. A template-string
    // renderer breaks on those; this one goes through JSON.stringify.
    const awkward = { ...entry, cbsaName: 'Lee\'s Summit "Metro" Area\\test' };
    const mod = await load(renderSourcedModule({ 'kansas-city-mo': awkward }, { writtenOn: '2026-01-01' }));
    expect(mod.SOURCED['kansas-city-mo'].cbsaName).toBe(awkward.cbsaName);
  });
});
