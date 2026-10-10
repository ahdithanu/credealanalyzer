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

import { SOURCES, buildRequest, allowedHostsFor, attributionsFor, parseDelimited } from './sources';
import { createTransport, MemoryHttpCache, createBreaker } from './transport';
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
  secrets = {},
  unpackArchive = null,
  seed = [],
  at = {},
  priorPopulation = {},
  cbsaToMarket = {},
  countyToMarket = {},
  knownHashes = new Set(),
  recordedAt = new Date(),
  runId = `run-${Date.now()}`,
} = {}) {
  if (typeof client !== 'function') throw new Error('runPipeline needs a transport from createTransport()');
  const report304 = [];

  const landed = [];
  const failures = [];
  const attributions = new Set();

  for (const step of plan) {
    const source = SOURCES[step.sourceId];
    if (!source) { failures.push({ step, error: `unknown source ${step.sourceId}` }); continue; }
    try {
      const pages = await fetchAllPages({ client, source, step, secrets });
      let payload = pages.length > 1 && source.mergePages
        ? source.mergePages(pages.map((p) => p.body))
        : pages[0].body;

      // Archive formats: a tax roll is a zip of pipe-delimited text. Unzipping
      // needs a real archive reader, so it is injected like fetch rather than
      // pulled in as a dependency of the pipeline itself.
      const descriptor = pages[0].unpack;
      if (descriptor) {
        {
          if (typeof unpackArchive !== 'function') {
            throw new Error(`${step.sourceId} returns a ${descriptor.format} archive and needs an unpackArchive implementation`);
          }
          const text = await unpackArchive({ buffer: payload, ...descriptor });
          payload = parseDelimited(text, { delimiter: descriptor.delimiter });
        }
      }

      if (pages.every((p) => p.notModified)) {
        // Nothing changed upstream. Landing it anyway is harmless — the content
        // hash dedupes it — but recording the saving is what tells an operator
        // the conditional requests are working.
        report304.push(step.sourceId);
      }

      if (source.attribution) attributions.add(source.attribution);

      landed.push({
        ...land(payload, { sourceId: step.sourceId, url: pages[0].url, fetchedAt: recordedAt }),
        context: step.context ?? {},
        marketKey: step.marketKey ?? null,
      });
    } catch (err) {
      failures.push({ step: { sourceId: step.sourceId }, error: err.message });
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
    attributions: [...attributions],
    report: {
      ...report,
      planSteps: plan.length,
      notModified: report304,
      landed: landed.length,
      fresh: fresh.length,
      skippedAsUnchanged: landed.length - fresh.length,
      failures,
    },
  };
}

/**
 * Follow a source's pagination to exhaustion.
 *
 * Bounded: a provider whose cursor never terminates would otherwise spin
 * indefinitely, and that failure is silent until the bill arrives.
 */
async function fetchAllPages({ client, source, step, secrets, maxPages = 50 }) {
  const pages = [];
  let params = step.params ?? {};

  for (let i = 0; i < maxPages; i++) {
    const req = buildRequest(step.sourceId, { params, secrets });
    const res = await client({ ...req, sourceId: step.sourceId });
    pages.push({ ...res, url: req.url, unpack: req.unpack ?? null });

    if (!source.nextPage) break;
    const next = source.nextPage({ params, body: res.body });
    if (!next) break;
    params = next;
  }
  return pages;
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

/**
 * Build a transport scoped to exactly the hosts a plan needs.
 *
 * The allowlist is derived from the plan rather than configured separately, so
 * it cannot drift out of step with what the pipeline actually calls.
 */
export function transportFor(plan, { fetchImpl, userAgent, secrets = {}, ...rest } = {}) {
  return createTransport({
    fetchImpl,
    userAgent,
    secrets,
    allowedHosts: allowedHostsFor(plan),
    ...rest,
  });
}

export { createTransport, MemoryHttpCache, createBreaker, allowedHostsFor, attributionsFor };
