/**
 * Serving projection: graph + facts -> the market feature vectors the app reads.
 *
 * The contract is `src/lib/markets.js`. Two properties matter:
 *
 *   1. Provenance is per feature, not per record. Sourcing lands one feature at
 *      a time, so a market can hold a sourced tax rate next to a seeded supply
 *      pipeline, and the UI must be able to warn about exactly the second one.
 *   2. A seed value is never silently promoted. If no fact backs a feature, the
 *      seed carries through with `quality: 'seed'` and the warning stays up.
 */

import { licensedOnlyFeatures } from './sources';

/**
 * Every feature the market scorecard consumes. This list must stay in step with
 * marketScore.FEATURES — a feature missing here is one that never gets coverage
 * accounting and never gets flagged, which is exactly the silent failure the
 * provenance model exists to prevent. A test asserts the two agree.
 *
 * `marketCapRate` is nested by property type rather than flat; it is carried
 * here so it is accounted for, and stays seeded until a licensed source lands.
 */
export const FEATURES = [
  'effectiveTaxRate', 'population', 'popGrowth5y', 'employmentGrowth',
  'medianHHI', 'supplyPipeline', 'rentGrowth', 'trafficCount', 'marketCapRate',
];

/**
 * @param {Object} opts
 * @param {import('./graph').Graph}      opts.graph
 * @param {import('./temporal').FactStore} opts.facts
 * @param {Array}  opts.seed      current seed markets, as the fallback
 * @param {Object} opts.at        { validAt, knownAt } — pin both to reproduce a past run
 * @returns {{markets:Array, coverage:Object}}
 */
export function projectMarkets({ graph, facts, seed = [], at = {}, priorPopulation = {} } = {}) {
  const markets = [];
  const counts = Object.fromEntries(FEATURES.map((f) => [f, { sourced: 0, seed: 0 }]));

  for (const base of seed) {
    const metroId = `metro:${base.key}`;
    const jurisdictionIds = graph
      ? graph.edgesOf(metroId, { type: 'located_in', direction: 'in' })
          .flatMap((e) => graph.edgesOf(e.from, { type: 'taxed_by', direction: 'out' }).map((t) => t.to))
      : [];

    const record = { ...base };
    const byFeature = {};

    for (const feature of FEATURES) {
      const fact = lookupFeature({ facts, graph, metroId, jurisdictionIds, feature, at, priorPopulation, base });
      if (fact && fact.value !== null && fact.value !== undefined) {
        record[feature] = fact.value;
        byFeature[feature] = { quality: 'sourced', source: fact.source, asOf: fact.validFrom };
        counts[feature].sourced++;
      } else {
        byFeature[feature] = {
          quality: 'seed',
          source: null,
          asOf: null,
          reason: licensedOnlyFeatures([feature]).length
            ? 'only available from a licensed source'
            : 'no sourced observation for this market',
        };
        counts[feature].seed++;
      }
    }

    // The record-level flag is the weakest link: one seeded feature keeps the
    // whole market marked, because a reader glancing at the header should not
    // be reassured by partial sourcing.
    const anySeed = Object.values(byFeature).some((p) => p.quality === 'seed');
    record.provenance = {
      dataQuality: anySeed ? 'partial' : 'sourced',
      sourcedFeatures: Object.values(byFeature).filter((p) => p.quality === 'sourced').length,
      totalFeatures: FEATURES.length,
      byFeature,
    };
    if (Object.values(byFeature).every((p) => p.quality === 'seed')) {
      record.provenance.dataQuality = 'seed';
    }

    markets.push(record);
  }

  return {
    markets,
    coverage: {
      byFeature: Object.fromEntries(
        Object.entries(counts).map(([f, c]) => [f, { ...c, pct: c.sourced / (c.sourced + c.seed || 1) }]),
      ),
      licensedOnly: licensedOnlyFeatures(FEATURES),
      fullySourced: markets.filter((m) => m.provenance.dataQuality === 'sourced').length,
      total: markets.length,
    },
  };
}

function lookupFeature({ facts, graph, metroId, jurisdictionIds, feature, at, priorPopulation }) {
  if (!facts) return null;

  if (feature === 'effectiveTaxRate') {
    // Parcel-weighted would be better; the modal jurisdiction rate is the
    // defensible approximation until parcel coverage is complete.
    for (const jid of jurisdictionIds) {
      const f = facts.get(jid, 'effectiveTaxRate', at);
      if (f) return f;
    }
    return null;
  }

  if (feature === 'popGrowth5y') {
    const now = facts.get(metroId, 'population', at);
    const prior = priorPopulation[metroId];
    if (!now || !prior?.value || !prior.years) return null;
    const cagr = (Math.pow(now.value / prior.value, 1 / prior.years) - 1) * 100;
    return { value: Number(cagr.toFixed(2)), source: `${now.source} + ${prior.source}`, validFrom: now.validFrom };
  }

  if (feature === 'employmentGrowth') {
    const series = facts.facts
      .filter((f) => f.subject === metroId && f.predicate === 'employment')
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    if (series.length < 2) return null;
    const latest = series[series.length - 1];
    const target = `${Number(latest.validFrom.slice(0, 4)) - 1}${latest.validFrom.slice(4)}`;
    const prior = series.find((f) => f.validFrom === target);
    if (!prior || !prior.value) return null;
    const growth = ((latest.value - prior.value) / prior.value) * 100;
    return { value: Number(growth.toFixed(2)), source: latest.source, validFrom: latest.validFrom };
  }

  return facts.get(metroId, feature, at);
}

/** The generated artifact the application loads. */
export function toMarketDataFile({ markets, coverage }, { generatedAt = new Date(), runId = null } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    runId,
    coverage,
    markets,
  };
}
