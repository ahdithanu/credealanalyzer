import { runPipeline, applyMarketData, defaultPlan, transportFor } from '../run';
import { censusACS, blsCES, hcadZipBytes, txdotAADT, CBSA_TO_MARKET, fixtureFetch, fakeUnpackArchive } from '../fixtures';
import { markets as seedMarkets } from '../../lib/markets';

const AT = { validAt: '2025-06-01', knownAt: '2026-06-01' };
const RECORDED = new Date('2026-01-15T00:00:00.000Z');

const routes = {
  'acs/acs5': censusACS,
  'bls.gov': blsCES,
  'hcad.org': { binary: hcadZipBytes },
  'arcgis.com': txdotAADT,
};

const client = (routeSet = routes) => transportFor(defaultPlan(), {
  fetchImpl: fixtureFetch(routeSet),
  userAgent: 'cre-deal-analyzer-tests (ops@example.com)',
  sleep: () => Promise.resolve(),
});

const opts = {
  plan: defaultPlan(),
  unpackArchive: fakeUnpackArchive,
  seed: seedMarkets,
  at: AT,
  cbsaToMarket: CBSA_TO_MARKET,
  countyToMarket: { hcad: 'houston-tx' },
  recordedAt: RECORDED,
  runId: 'test-run',
  priorPopulation: { 'metro:houston-tx': { value: 6_665_238, years: 5, source: 'census.acs5:2020' } },
};

describe('runPipeline', () => {
  it('refuses to run without an injected transport', async () => {
    await expect(runPipeline({ plan: [] })).rejects.toThrow(/transport/);
  });

  it('runs the default plan end to end and emits a versioned artifact', async () => {
    const { artifact, report } = await runPipeline({ ...opts, client: client() });
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.runId).toBe('test-run');
    expect(artifact.markets).toHaveLength(seedMarkets.length);
    expect(report.planSteps).toBe(defaultPlan().length);
  });

  it('reports the licensed source as unfetchable rather than skipping it silently', async () => {
    // The gap has to stay visible or it quietly stops being attempted.
    const { report } = await runPipeline({ ...opts, client: client() });
    const costar = report.failures.find((f) => f.step.sourceId === 'costar.market');
    expect(costar).toBeDefined();
    expect(costar.error).toMatch(/licensed|no fetchable URL/i);
  });

  it('degrades rather than aborting when one source fails', async () => {
    const partial = client({ 'acs/acs5': censusACS });   // everything else 404s
    const { artifact, report } = await runPipeline({ ...opts, client: partial });
    expect(report.failures.length).toBeGreaterThan(1);
    const houston = artifact.markets.find((m) => m.key === 'houston-tx');
    expect(houston.provenance.byFeature.population.quality).toBe('sourced');
    expect(houston.provenance.byFeature.effectiveTaxRate.quality).toBe('seed');
  });

  it('skips payloads whose content has not changed since the last run', async () => {
    const first = await runPipeline({ ...opts, client: client() });
    const hashes = new Set(Object.values(first.artifact.markets).length ? collectHashes(first) : []);
    const second = await runPipeline({ ...opts, client: client(), knownHashes: hashes });
    expect(second.report.skippedAsUnchanged).toBeGreaterThan(0);
  });

  it('is reproducible for a pinned pair of clocks', async () => {
    const a = await runPipeline({ ...opts, client: client() });
    const b = await runPipeline({ ...opts, client: client() });
    expect(b.artifact).toEqual(a.artifact);
  });

  it('carries the entity-resolution review queue out of the run', async () => {
    const { resolution } = await runPipeline({ ...opts, client: client() });
    expect(resolution.stats).toBeDefined();
    expect(Array.isArray(resolution.review)).toBe(true);
  });

  it('exposes a queryable graph after the run', async () => {
    const { graph } = await runPipeline({ ...opts, client: client() });
    const sunbelt = graph.nodesOfType('Entity').find((n) => /SUNBELT/i.test(n.props.canonicalName));
    expect(graph.portfolioOf(sunbelt.id).length).toBe(2);
    expect(graph.beneficialOwners('parcel:hcad:0001234567')[0].entity.id).toBe(sunbelt.id);
  });
});

function collectHashes(run) {
  // The run does not expose landed hashes directly; re-deriving them is enough
  // to prove the dedupe path, since land() is deterministic on content.
  const { land } = require('../stages');
  return [
    land(censusACS, { sourceId: 'census.acs5', fetchedAt: RECORDED }).hash,
    land(blsCES, { sourceId: 'bls.ces', fetchedAt: RECORDED }).hash,
  ];
}

describe('applyMarketData', () => {
  it('promotes only the sourced features', async () => {
    const { artifact } = await runPipeline({ ...opts, client: client() });
    const merged = applyMarketData(seedMarkets, artifact);
    const houston = merged.find((m) => m.key === 'houston-tx');
    const seedHouston = seedMarkets.find((m) => m.key === 'houston-tx');

    expect(houston.population).toBe(7_340_118);              // sourced, replaced
    expect(houston.supplyPipeline).toBe(seedHouston.supplyPipeline);  // seeded, untouched
  });

  it('leaves markets the run did not cover exactly as they were', async () => {
    const { artifact } = await runPipeline({ ...opts, client: client() });
    const merged = applyMarketData(seedMarkets, artifact);
    const miami = merged.find((m) => m.key === 'miami-fl');
    expect(miami.provenance.dataQuality).toBe('seed');
    expect(miami.population).toBe(seedMarkets.find((m) => m.key === 'miami-fl').population);
  });

  it('returns the seed untouched for an empty artifact', () => {
    expect(applyMarketData(seedMarkets, null)).toBe(seedMarkets);
    expect(applyMarketData(seedMarkets, { markets: [] })).toBe(seedMarkets);
  });

  it('keeps the app contract intact after merging', async () => {
    const { artifact } = await runPipeline({ ...opts, client: client() });
    for (const m of applyMarketData(seedMarkets, artifact)) {
      expect(typeof m.key).toBe('string');
      expect(typeof m.lat).toBe('number');
      expect(typeof m.effectiveTaxRate).toBe('number');
      expect(m.marketCapRate.carwash).toBeGreaterThan(0);
    }
  });
});
