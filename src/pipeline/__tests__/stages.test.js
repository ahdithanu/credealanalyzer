import { land, dedupeLanded, stage, canonicalize } from '../stages';
import { projectMarkets, toMarketDataFile, FEATURES } from '../project';
import { censusACS, blsCES, hcadRoll, dcadRoll, txdotAADT, CBSA_TO_MARKET } from '../fixtures';
import { markets as seedMarkets } from '../../lib/markets';
import { FEATURES as SCORE_FEATURES } from '../../lib/marketScore';

const AT = { validAt: '2025-06-01', knownAt: '2026-06-01' };
const COUNTY_TO_MARKET = { hcad: 'houston-tx', dcad: 'dallas-tx' };

function run() {
  const batches = [
    stage(land(censusACS, { sourceId: 'census.acs5', url: 'x' }), { vintage: 2025 }),
    { ...stage(land(blsCES, { sourceId: 'bls.ces', url: 'x' })), marketKey: 'houston-tx' },
    stage(land(hcadRoll, { sourceId: 'assessor.hcad', url: 'x' }), { county: 'hcad' }),
    stage(land(dcadRoll, { sourceId: 'assessor.hcad', url: 'x' }), { county: 'dcad' }),
    { ...stage(land(txdotAADT, { sourceId: 'txdot.aadt', url: 'x' })), marketKey: 'houston-tx' },
  ];
  return canonicalize(batches, {
    cbsaToMarket: CBSA_TO_MARKET,
    countyToMarket: COUNTY_TO_MARKET,
    recordedAt: '2026-01-15T00:00:00.000Z',
  });
}

describe('landing', () => {
  it('content-addresses a payload', () => {
    const a = land(censusACS, { sourceId: 'census.acs5' });
    const b = land(censusACS, { sourceId: 'census.acs5' });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different content a different hash', () => {
    expect(land(censusACS, { sourceId: 'census.acs5' }).hash)
      .not.toBe(land(blsCES, { sourceId: 'census.acs5' }).hash);
  });

  it('keeps the payload untouched, so a parser bug is a replay not a re-fetch', () => {
    expect(land(censusACS, { sourceId: 'census.acs5' }).payload).toBe(censusACS);
  });

  it('rejects an unregistered source', () => {
    expect(() => land([], { sourceId: 'not.a.source' })).toThrow(/unknown source/);
  });

  it('drops payloads already held', () => {
    const one = land(censusACS, { sourceId: 'census.acs5' });
    expect(dedupeLanded([one, one])).toHaveLength(1);
    expect(dedupeLanded([one], new Set([one.hash]))).toHaveLength(0);
  });
});

describe('staging', () => {
  it('parses through the registered parser', () => {
    const s = stage(land(censusACS, { sourceId: 'census.acs5' }), { vintage: 2025 });
    expect(s.records).toHaveLength(4);
    expect(s.errors).toEqual([]);
  });

  it('captures a parse failure instead of taking down the run', () => {
    // One malformed county file must not abort a forty-county batch.
    const s = stage(land({ nonsense: true }, { sourceId: 'census.acs5' }));
    expect(s.records).toEqual([]);
    expect(s.errors[0]).toMatch(/array of arrays/);
  });

  it('carries the landed hash forward for lineage', () => {
    const l = land(censusACS, { sourceId: 'census.acs5' });
    expect(stage(l, { vintage: 2025 }).landedHash).toBe(l.hash);
  });
});

describe('canonicalize', () => {
  const { graph, facts, resolution, report } = run();

  it('builds metro nodes from the geography mapping', () => {
    expect(graph.getNode('metro:houston-tx')).toBeTruthy();
    expect(graph.getNode('metro:dallas-tx')).toBeTruthy();
  });

  it('reports geographies it could not map rather than dropping them silently', () => {
    const { report: r } = canonicalize(
      [stage(land(censusACS, { sourceId: 'census.acs5' }), { vintage: 2025 })],
      { cbsaToMarket: { 26420: 'houston-tx' } },
    );
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(r.skipped.join(' ')).toMatch(/no market mapping/);
  });

  it('asserts census observations with their vintage as valid time', () => {
    const f = facts.get('metro:houston-tx', 'population', AT);
    expect(f.value).toBe(7_340_118);
    expect(f.validFrom).toBe('2025-01-01');
    expect(f.source).toBe('census.acs5:2025');
  });

  it('creates parcels and ties them to their jurisdiction and metro', () => {
    expect(graph.getNode('parcel:hcad:0001234567')).toBeTruthy();
    const taxed = graph.edgesOf('parcel:hcad:0001234567', { type: 'taxed_by' });
    expect(taxed).toHaveLength(1);
    expect(graph.edgesOf('parcel:hcad:0001234567', { type: 'located_in' })[0].to).toBe('metro:houston-tx');
  });

  it('records the tax rate against the jurisdiction with a valid year', () => {
    const f = facts.get('jurisdiction:hcad', 'effectiveTaxRate', AT);
    expect(f.value).toBe(2.81);
    expect(f.validFrom).toBe('2025-01-01');
    expect(f.validTo).toBe('2026-01-01');
  });

  it('resolves the same owner spelled three ways across two counties', () => {
    // "SUNBELT CAR WASH HOLDINGS LLC", "Sunbelt Car Wash Holdings, L.L.C."
    // and "SUNBELT CAR WASH HLDGS LLC" are one entity.
    const sunbelt = graph.nodesOfType('Entity').find((n) => /SUNBELT/i.test(n.props.canonicalName));
    expect(sunbelt.props.memberCount).toBe(3);
    expect(graph.portfolioOf(sunbelt.id).map((p) => p.id).sort()).toEqual([
      'parcel:dcad:00000700123400000',
      'parcel:hcad:0001234567',
      'parcel:hcad:0001234568',
    ]);
  });

  it('keeps unrelated owners in separate entities', () => {
    expect(graph.nodesOfType('Entity').length).toBe(3);
  });

  it('surfaces the entity-resolution review queue', () => {
    expect(resolution.stats.records).toBe(5);
    expect(Array.isArray(resolution.review)).toBe(true);
  });

  it('counts what it processed', () => {
    expect(report.records).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
  });
});

describe('projection', () => {
  const { graph, facts } = run();
  const priorPopulation = {
    'metro:houston-tx': { value: 6_665_238, years: 5, source: 'census.acs5:2020' },
  };
  const { markets, coverage } = projectMarkets({ graph, facts, seed: seedMarkets, at: AT, priorPopulation });

  it('returns one record per seed market, preserving the app contract', () => {
    expect(markets).toHaveLength(seedMarkets.length);
    for (const m of markets) {
      expect(typeof m.key).toBe('string');
      expect(typeof m.lat).toBe('number');
      expect(m.marketCapRate).toBeDefined();
    }
  });

  it('overwrites a seeded value with the sourced one', () => {
    const houston = markets.find((m) => m.key === 'houston-tx');
    expect(houston.population).toBe(7_340_118);
    expect(houston.provenance.byFeature.population.quality).toBe('sourced');
    expect(houston.provenance.byFeature.population.source).toBe('census.acs5:2025');
  });

  it('derives population growth as a CAGR over the prior vintage', () => {
    const houston = markets.find((m) => m.key === 'houston-tx');
    const expected = (Math.pow(7_340_118 / 6_665_238, 1 / 5) - 1) * 100;
    expect(houston.popGrowth5y).toBeCloseTo(Number(expected.toFixed(2)), 2);
  });

  it('derives employment growth year over year', () => {
    const houston = markets.find((m) => m.key === 'houston-tx');
    expect(houston.provenance.byFeature.employmentGrowth.quality).toBe('sourced');
    expect(houston.employmentGrowth).toBeCloseTo(((3489.2 - 3407.1) / 3407.1) * 100, 1);
  });

  it('sources the tax rate through parcel to jurisdiction', () => {
    const houston = markets.find((m) => m.key === 'houston-tx');
    expect(houston.effectiveTaxRate).toBe(2.81);
    expect(houston.provenance.byFeature.effectiveTaxRate.quality).toBe('sourced');
  });

  it('never silently promotes a seed value', () => {
    const houston = markets.find((m) => m.key === 'houston-tx');
    // Supply pipeline has no free source, so it stays seeded and stays flagged.
    expect(houston.provenance.byFeature.supplyPipeline.quality).toBe('seed');
    expect(houston.provenance.byFeature.supplyPipeline.reason).toMatch(/licensed/);
  });

  it('marks a partially-sourced market as partial, not sourced', () => {
    const houston = markets.find((m) => m.key === 'houston-tx');
    expect(houston.provenance.dataQuality).toBe('partial');
    expect(houston.provenance.sourcedFeatures).toBeGreaterThan(0);
    expect(houston.provenance.sourcedFeatures).toBeLessThan(FEATURES.length);
  });

  it('leaves an untouched market entirely seeded', () => {
    const miami = markets.find((m) => m.key === 'miami-fl');
    expect(miami.provenance.dataQuality).toBe('seed');
    expect(miami.provenance.sourcedFeatures).toBe(0);
  });

  it('reports coverage per feature and names the licensed-only ones', () => {
    expect(coverage.byFeature.population.sourced).toBeGreaterThan(0);
    expect(coverage.byFeature.supplyPipeline.sourced).toBe(0);
    expect(coverage.licensedOnly.sort()).toEqual(['marketCapRate', 'rentGrowth', 'supplyPipeline']);
    expect(coverage.byFeature.marketCapRate.sourced).toBe(0);
    expect(coverage.total).toBe(seedMarkets.length);
  });

  it('is reproducible when both clocks are pinned', () => {
    const again = projectMarkets({ graph, facts, seed: seedMarkets, at: AT, priorPopulation });
    expect(again.markets).toEqual(markets);
  });

  it('emits a versioned artifact with a generation timestamp', () => {
    const file = toMarketDataFile({ markets, coverage }, { generatedAt: new Date('2026-06-01'), runId: 'run-1' });
    expect(file.schemaVersion).toBe(1);
    expect(file.runId).toBe('run-1');
    expect(file.markets).toHaveLength(markets.length);
  });
});

describe('projection contract', () => {
  it('covers every feature the market scorecard scores', () => {
    // A scorecard feature absent from the projection would never be coverage
    // accounted and never flagged — the exact silent gap provenance prevents.
    expect([...FEATURES].sort()).toEqual([...SCORE_FEATURES.map((f) => f.key)].sort());
  });

  it('leaves a nested seed feature intact when no source backs it', () => {
    const { graph, facts } = run();
    const { markets } = projectMarkets({ graph, facts, seed: seedMarkets, at: AT });
    const houston = markets.find((m) => m.key === 'houston-tx');
    expect(houston.marketCapRate.carwash).toBe(7.6);
    expect(houston.provenance.byFeature.marketCapRate.quality).toBe('seed');
  });
});
