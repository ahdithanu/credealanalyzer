/**
 * Pipeline orchestrator.
 *
 * A run is a pure function of its plan and its client. The client is injected,
 * so the same code path executes against fixtures in tests and against the
 * network in production — there is no `if (test)` branch anywhere inside.
 *
 * Running it for real:
 *
 *   CENSUS_API_KEY=… BLS_API_KEY=… npx tsx src/pipeline/run.js --vintage 2025
 *
 * (tsx, or any ESM-aware runner — this package is not configured as ESM for
 * Node, because the same modules are consumed by the application bundler.)
 */

import { SOURCES, createClient } from './sources';
import { land, dedupeLanded, stage, canonicalize } from './stages';
import { projectMarkets, toMarketDataFile } from './project';

/**
 * @typedef {Object} PlanStep
 * @property {string} sourceId
 * @property {Object} params      passed to the source's url builder
 * @property {Object} context     passed to the parser (county, vintage, …)
 * @property {string} [marketKey] for sources whose payload has no geography id
 */

/**
 * Execute a plan.
 *
 * Steps are independent: one failing source degrades coverage for the features
 * it provides and is reported, rather than aborting the run. A pipeline that
 * refuses to produce anything because one county's file moved is a pipeline
 * nobody runs.
 */
export async function runPipeline({
  client,
  plan,
  seed = [],
  at = {},
  priorPopulation = {},
  cbsaToMarket = {},
  countyToMarket = {},
  knownHashes = new Set(),
  recordedAt = new Date(),
  runId = `run-${Date.now()}`,
} = {}) {
  if (typeof client !== 'function') throw new Error('runPipeline needs a client from createClient()');

  const landed = [];
  const failures = [];

  for (const step of plan) {
    const source = SOURCES[step.sourceId];
    if (!source) { failures.push({ step, error: `unknown source ${step.sourceId}` }); continue; }
    if (!source.url) { failures.push({ step, error: `${step.sourceId} has no fetchable URL (${source.note ?? 'licensed'})` }); continue; }
    try {
      const url = source.url(step.params ?? {});
      const res = await client(url);
      landed.push({
        ...land(res.body, { sourceId: step.sourceId, url, fetchedAt: recordedAt }),
        context: step.context ?? {},
        marketKey: step.marketKey ?? null,
      });
    } catch (err) {
      failures.push({ step, error: err.message });
    }
  }

  const fresh = dedupeLanded(landed, knownHashes);
  const batches = fresh.map((l) => ({
    ...stage(l, l.context),
    marketKey: l.marketKey,
  }));

  const { graph, facts, resolution, report } = canonicalize(batches, {
    cbsaToMarket, countyToMarket, recordedAt,
  });

  const projection = projectMarkets({ graph, facts, seed, at, priorPopulation });

  return {
    runId,
    artifact: toMarketDataFile(projection, { generatedAt: recordedAt, runId }),
    graph,
    facts,
    resolution,
    report: {
      ...report,
      planSteps: plan.length,
      landed: landed.length,
      fresh: fresh.length,
      skippedAsUnchanged: landed.length - fresh.length,
      failures,
    },
  };
}

/**
 * Merge a generated artifact over the seed markets.
 *
 * Kept separate from the run so promoting pipeline output into the application
 * is an explicit, reviewable step. Sourced features win; everything else keeps
 * its seed value and its warning.
 */
export function applyMarketData(seed, artifact) {
  if (!artifact?.markets?.length) return seed;
  const byKey = new Map(artifact.markets.map((m) => [m.key, m]));
  return seed.map((base) => {
    const generated = byKey.get(base.key);
    if (!generated) return base;
    const merged = { ...base };
    for (const [feature, prov] of Object.entries(generated.provenance?.byFeature ?? {})) {
      if (prov.quality === 'sourced') merged[feature] = generated[feature];
    }
    merged.provenance = generated.provenance;
    return merged;
  });
}

/** A default plan for the Texas markets the app currently covers. */
export function defaultPlan({ vintage = 2025, taxYear = 2025, trafficYear = 2025 } = {}) {
  return [
    { sourceId: 'census.acs5', params: { vintage }, context: { vintage } },
    { sourceId: 'bls.ces', params: { seriesId: 'SMU48264200000000001' }, marketKey: 'houston-tx' },
    { sourceId: 'bls.ces', params: { seriesId: 'SMU48191000000000001' }, marketKey: 'dallas-tx' },
    { sourceId: 'assessor.hcad', params: { taxYear }, context: { county: 'hcad', taxYear } },
    { sourceId: 'txdot.aadt', params: { year: trafficYear }, marketKey: 'houston-tx' },
    // Included deliberately: the run reports it as unfetchable, which is how the
    // licensed gap stays visible instead of quietly never being attempted.
    { sourceId: 'costar.market', params: {} },
  ];
}

export { createClient };
