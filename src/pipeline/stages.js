/**
 * The four pipeline layers.
 *
 *   landing    raw payloads, immutable, content-addressed. Never parsed.
 *              Everything downstream must be re-derivable from here, so a
 *              parser bug is a replay rather than a re-fetch.
 *   staging    typed, validated records. One source per batch, no joins yet.
 *   canonical  entities and edges into the graph; observations into the fact
 *              store. This is where entity resolution happens.
 *   serving    a projection into the shape the application consumes.
 *
 * The boundaries matter more than the tools. Each layer is a pure function of
 * the one before it, which is what makes the whole pipeline replayable and
 * testable without a network.
 */

import { createHash } from 'crypto';
import { SOURCES, ParseError } from './sources';
import { FactStore } from './temporal';
import { Graph } from './graph';
import { resolveEntities, normalizeEntityName } from './resolve';

// ── Landing ─────────────────────────────────────────────────────────────────

/**
 * Wrap a raw payload with its provenance and a content hash.
 * The hash is the identity: re-fetching unchanged data is a no-op downstream.
 */
export function land(payload, { sourceId, url, fetchedAt = new Date() }) {
  if (!SOURCES[sourceId]) throw new Error(`landing: unknown source "${sourceId}"`);
  const body = JSON.stringify(payload);
  return {
    hash: createHash('sha256').update(body).digest('hex'),
    sourceId,
    url: url ?? null,
    fetchedAt: fetchedAt instanceof Date ? fetchedAt.toISOString() : String(fetchedAt),
    bytes: body.length,
    payload,
  };
}

/** Drop payloads whose content we already hold. */
export function dedupeLanded(landed, knownHashes = new Set()) {
  const fresh = [];
  const seen = new Set(knownHashes);
  for (const l of landed) {
    if (seen.has(l.hash)) continue;
    seen.add(l.hash);
    fresh.push(l);
  }
  return fresh;
}

// ── Staging ─────────────────────────────────────────────────────────────────

/**
 * Parse a landed payload into typed records. Parse failures are captured per
 * batch rather than thrown: one malformed county file must not take down a run
 * across forty counties.
 */
export function stage(landed, context = {}) {
  const source = SOURCES[landed.sourceId];
  if (!source?.parser) {
    return { sourceId: landed.sourceId, records: [], errors: [`no parser registered for ${landed.sourceId}`], landedHash: landed.hash };
  }
  try {
    const records = source.parser(landed.payload, context);
    return {
      sourceId: landed.sourceId,
      landedHash: landed.hash,
      fetchedAt: landed.fetchedAt,
      records,
      errors: [],
    };
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    return { sourceId: landed.sourceId, landedHash: landed.hash, fetchedAt: landed.fetchedAt, records: [], errors: [err.message] };
  }
}

// ── Canonical ───────────────────────────────────────────────────────────────

/**
 * Fold staged batches into a graph and a fact store.
 *
 * @param {Array} batches            output of stage()
 * @param {Object} opts
 * @param {Object} opts.cbsaToMarket geography id -> market key
 * @param {Object} opts.countyToMarket
 * @returns {{graph:Graph, facts:FactStore, resolution:Object, report:Object}}
 */
export function canonicalize(batches, { cbsaToMarket = {}, countyToMarket = {}, recordedAt = new Date() } = {}) {
  const graph = new Graph();
  const facts = new FactStore();
  const recorded = recordedAt instanceof Date ? recordedAt.toISOString() : String(recordedAt);
  const report = { batches: batches.length, records: 0, errors: [], skipped: [] };

  const ownerRecords = [];

  for (const batch of batches) {
    report.errors.push(...batch.errors.map((e) => `${batch.sourceId}: ${e}`));
    report.records += batch.records.length;

    if (batch.sourceId === 'census.acs5') {
      for (const r of batch.records) {
        const marketKey = cbsaToMarket[r.geoId];
        if (!marketKey) { report.skipped.push(`census geo ${r.geoId} has no market mapping`); continue; }
        const id = `metro:${marketKey}`;
        graph.addNode({ id, type: 'Metro', props: { marketKey, name: r.name, cbsa: r.geoId } });
        for (const field of ['population', 'medianHHI', 'medianHomeValue', 'employed']) {
          if (r[field] === undefined || r[field] === null) continue;
          facts.assert({
            subject: id, predicate: field, value: r[field],
            validFrom: `${r.vintage ?? new Date().getFullYear()}-01-01`,
            validTo: `${(r.vintage ?? new Date().getFullYear()) + 1}-01-01`,
            recordedAt: recorded, source: `${batch.sourceId}:${r.vintage}`,
          });
        }
      }
    }

    else if (batch.sourceId === 'bls.ces') {
      for (const r of batch.records) {
        const marketKey = batch.marketKey ?? cbsaToMarket[batch.geoId];
        if (!marketKey) { report.skipped.push(`bls series ${r.seriesId} has no market mapping`); continue; }
        const id = `metro:${marketKey}`;
        if (!graph.getNode(id)) graph.addNode({ id, type: 'Metro', props: { marketKey } });
        facts.assert({
          subject: id, predicate: 'employment', value: r.value,
          validFrom: r.validFrom, recordedAt: recorded, source: `${batch.sourceId}:${r.seriesId}`,
        });
      }
    }

    else if (batch.sourceId.startsWith('assessor.')) {
      for (const r of batch.records) {
        graph.addNode({
          id: r.parcelId, type: 'Parcel',
          props: { account: r.account, county: r.county, situs: r.situsAddress, lat: r.lat, lng: r.lng },
        });

        const marketKey = countyToMarket[r.county];
        if (marketKey) {
          const metroId = `metro:${marketKey}`;
          if (!graph.getNode(metroId)) graph.addNode({ id: metroId, type: 'Metro', props: { marketKey } });
          graph.addEdge({ from: r.parcelId, to: metroId, type: 'located_in' });
        }

        if (r.taxRate !== null) {
          const jurisdictionId = `jurisdiction:${r.county}`;
          graph.addNode({ id: jurisdictionId, type: 'Jurisdiction', props: { county: r.county } });
          graph.addEdge({ from: r.parcelId, to: jurisdictionId, type: 'taxed_by' });
          facts.assert({
            subject: jurisdictionId, predicate: 'effectiveTaxRate', value: r.taxRate,
            validFrom: r.validFrom, validTo: r.validTo, recordedAt: recorded,
            source: `${batch.sourceId}:${r.taxYear}`,
          });
        }

        if (r.appraisedValue !== null) {
          facts.assert({
            subject: r.parcelId, predicate: 'appraisedValue', value: r.appraisedValue,
            validFrom: r.validFrom, validTo: r.validTo, recordedAt: recorded,
            source: `${batch.sourceId}:${r.taxYear}`,
          });
        }

        if (r.ownerName) {
          ownerRecords.push({
            id: `${r.parcelId}#owner`, name: r.ownerName, address: r.ownerAddress, parcelId: r.parcelId,
          });
        }
      }
    }

    else if (batch.sourceId === 'txdot.aadt') {
      for (const r of batch.records) {
        const marketKey = batch.marketKey;
        if (!marketKey) { report.skipped.push(`traffic station ${r.stationId} has no market mapping`); continue; }
        const id = `metro:${marketKey}`;
        if (!graph.getNode(id)) graph.addNode({ id, type: 'Metro', props: { marketKey } });
        facts.assert({
          subject: id, predicate: 'trafficCount', value: r.aadt,
          validFrom: `${r.year}-01-01`, validTo: `${r.year + 1}-01-01`,
          recordedAt: recorded, source: `${batch.sourceId}:${r.stationId}`,
        });
      }
    }
  }

  // Entity resolution across every owner name seen, then one Entity node per
  // cluster with an owned_by edge from each parcel in it.
  const resolution = resolveEntities(ownerRecords);
  for (const cluster of resolution.clusters) {
    const entityId = `entity:${normalizeEntityName(cluster.canonicalName).core.replace(/\s+/g, '-').toLowerCase()}`;
    graph.addNode({
      id: entityId, type: 'Entity',
      props: { canonicalName: cluster.canonicalName, aliases: cluster.members.map((m) => m.name), memberCount: cluster.members.length },
    });
    for (const member of cluster.members) {
      if (graph.getNode(member.parcelId)) {
        graph.addEdge({ from: member.parcelId, to: entityId, type: 'owned_by' });
      }
    }
  }

  return { graph, facts, resolution, report };
}
