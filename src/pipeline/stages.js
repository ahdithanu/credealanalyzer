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
 * One effective tax rate per jurisdiction per tax year, from the per-parcel
 * rates on the roll.
 *
 * The modal rate — the one most parcels in the county are actually charged —
 * which is what project.js already documents itself as reading. Ties break on
 * the HIGHER rate: property tax is a cost, so the conservative reading is the
 * one an underwriting should carry when the roll does not settle the question.
 * Deliberately not an average: the mean of 2.42 and 2.15 is a rate no parcel
 * pays, and it would be presented as a sourced figure.
 */
function jurisdictionSummary(rates) {
  const byKey = new Map();
  for (const r of rates) {
    const key = `${r.jurisdictionId}|${r.taxYear}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const out = [];
  for (const group of byKey.values()) {
    const counts = new Map();
    for (const r of group) counts.set(r.taxRate, (counts.get(r.taxRate) ?? 0) + 1);
    let best = null;
    for (const [rate, n] of counts) {
      if (best === null || n > best.n || (n === best.n && rate > best.rate)) best = { rate, n };
    }
    const first = group[0];
    out.push({
      jurisdictionId: first.jurisdictionId,
      taxYear: first.taxYear,
      sourceId: first.sourceId,
      validFrom: first.validFrom,
      validTo: first.validTo,
      taxRate: best.rate,
      parcels: group.length,
      distinctRates: counts.size,
    });
  }
  return out;
}

/**
 * One representative arterial count per metro per year, from the stations read.
 *
 * markets.js defines `trafficCount` as a REPRESENTATIVE arterial AADT, so this
 * reports a count a station actually measured rather than a mean of several,
 * which would be a figure no road carries presented as a sourced observation.
 * The lower of the two middle stations: the median is the representative one,
 * and where the stations straddle it the lower count is the conservative
 * underwriting — traffic drives revenue on the property types that read it.
 */
function representativeTraffic(stations) {
  const byKey = new Map();
  for (const s of stations) {
    if (s.aadt === null || s.aadt === undefined) continue;
    const key = `${s.id}|${s.year}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }
  const out = [];
  for (const group of byKey.values()) {
    const sorted = [...group].sort((a, b) => a.aadt - b.aadt || String(a.stationId).localeCompare(String(b.stationId)));
    const pick = sorted[Math.floor((sorted.length - 1) / 2)];
    out.push({ ...pick, stations: group.length });
  }
  return out;
}

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
      const jurisdictionRates = [];
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
          // Collected, not asserted per parcel. Every parcel in a county wrote
          // its OWN rate to the same jurisdiction key, in the same batch, over
          // the same tax-year window — so the rows tied on both clocks and on
          // the valid window by construction, and the store's answer was decided
          // by row order in the assessor download (Dallas: 2.42% or 2.15%, 27
          // bps apart, surfaced verbatim on the Market Intelligence screen).
          // corrections() then reported the pair as a retroactive correction
          // between two unrelated parcels, which is the report an underwriter is
          // meant to trust after a deal is approved. One fact per jurisdiction
          // per tax year is what project.js already documents itself as reading.
          jurisdictionRates.push({ jurisdictionId, county: r.county, taxRate: r.taxRate,
            validFrom: r.validFrom, validTo: r.validTo, taxYear: r.taxYear, sourceId: batch.sourceId });
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

      for (const j of jurisdictionSummary(jurisdictionRates)) {
        facts.assert({
          subject: j.jurisdictionId, predicate: 'effectiveTaxRate', value: j.taxRate,
          validFrom: j.validFrom, validTo: j.validTo, recordedAt: recorded,
          source: `${j.sourceId}:${j.taxYear}`,
        });
        // A roll whose parcels disagree is a real fact about the county, and
        // the modal rate hides it. Reported rather than dropped.
        if (j.parcels > 1 && j.distinctRates > 1) {
          report.skipped.push(
            `${j.jurisdictionId} ${j.taxYear}: ${j.distinctRates} distinct parcel tax rates across ` +
            `${j.parcels} parcels, reported at the modal ${j.taxRate}`,
          );
        }
      }
    }

    else if (batch.sourceId === 'txdot.aadt') {
      // Same collision as the jurisdiction tax rate, and the same fix. Every
      // station in a metro wrote its own count to one metro key over one year,
      // in one batch, so the rows tied on both clocks and the window and the
      // store answered with whichever station came last in the feed — and
      // corrections() reported the pair (42,000 against 48,000) as a
      // retroactive correction. markets.js defines this feature as a single
      // REPRESENTATIVE arterial count, so one is chosen and the rest disclosed.
      const stations = [];
      for (const r of batch.records) {
        const marketKey = batch.marketKey;
        if (!marketKey) { report.skipped.push(`traffic station ${r.stationId} has no market mapping`); continue; }
        const id = `metro:${marketKey}`;
        if (!graph.getNode(id)) graph.addNode({ id, type: 'Metro', props: { marketKey } });
        stations.push({ id, year: r.year, aadt: r.aadt, stationId: r.stationId });
      }
      for (const t of representativeTraffic(stations)) {
        facts.assert({
          subject: t.id, predicate: 'trafficCount', value: t.aadt,
          validFrom: `${t.year}-01-01`, validTo: `${t.year + 1}-01-01`,
          recordedAt: recorded, source: `${batch.sourceId}:${t.stationId}`,
        });
        if (t.stations > 1) {
          report.skipped.push(
            `${t.id} ${t.year}: ${t.stations} traffic stations, reported at the representative ` +
            `${t.aadt} from ${t.stationId}`,
          );
        }
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
