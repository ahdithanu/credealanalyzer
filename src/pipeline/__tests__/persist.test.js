import { Graph } from '../graph';
import { FactStore } from '../temporal';
import {
  MemoryStore, saveSnapshot, loadSnapshot, listSnapshots, mergeInto,
  snapshotKey, SCHEMA_VERSION, __internals,
} from '../persist';

const KEY = snapshotKey('default');
const PREV = __internals.previousKey('default');

/** Parcel owned by an SPE, which a holdco controls — the ownership query. */
function ownershipGraph() {
  const g = new Graph();
  g.addNode({ id: 'parcel:a', type: 'Parcel', props: { situs: '100 Main St', acres: 2.4 } });
  g.addNode({ id: 'spe:a', type: 'Entity', props: { name: 'MAIN ST SPE LLC' } });
  g.addNode({ id: 'holdco:sunbelt', type: 'Entity', props: { name: 'SUNBELT HOLDINGS LLC' } });
  g.addEdge({ from: 'parcel:a', to: 'spe:a', type: 'owned_by' });
  g.addEdge({ from: 'spe:a', to: 'holdco:sunbelt', type: 'controlled_by' });
  return g;
}

/** What the 2025 roll said, ingested February 2025. */
function originalRoll() {
  const f = new FactStore();
  f.assert({
    subject: 'parcel:a', predicate: 'taxRate', value: 2.81,
    validFrom: '2025-01-01', validTo: '2026-01-01',
    recordedAt: '2025-02-01T00:00:00.000Z', source: 'hcad:2025',
  });
  return f;
}

/** The assessor's March 2026 correction, retroactive to the same 2025 period. */
function correctedRoll() {
  const f = new FactStore();
  f.assert({
    subject: 'parcel:a', predicate: 'taxRate', value: 2.68,
    validFrom: '2025-01-01', validTo: '2026-01-01',
    recordedAt: '2026-03-03T00:00:00.000Z', source: 'hcad:2025-corrected',
  });
  return f;
}

const AT_APPROVAL = { validAt: '2025-06-01', knownAt: '2025-12-01' };
const AT_NOW = { validAt: '2025-06-01', knownAt: '2026-09-01' };

const empty = () => ({ graph: new Graph(), facts: new FactStore() });

async function raw(store, key = KEY) {
  return store.get(key);
}

describe('persist — never saved is not the same as saved empty', () => {
  it('reports absence, and does not fabricate an empty snapshot', async () => {
    const store = new MemoryStore();
    const read = await loadSnapshot(store);
    expect(read.present).toBe(false);
    // null, not an empty Graph: a caller that seeds on absence must be able to
    // tell "nothing has ever run" from "the run observed nothing".
    expect(read.graph).toBeNull();
    expect(read.facts).toBeNull();
    expect(read.error).toBeNull();
    expect(read.meta).toBeNull();
  });

  it('reports a genuinely empty snapshot as present', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, empty());
    const read = await loadSnapshot(store);
    expect(read.present).toBe(true);
    expect(read.graph.nodes.size).toBe(0);
    expect(read.facts.size).toBe(0);
    expect(read.meta.counts).toEqual({ nodes: 0, edges: 0, facts: 0 });
  });
});

describe('persist — bitemporal round trip', () => {
  it('answers both clocks after a save and load in one run', async () => {
    const store = new MemoryStore();
    const facts = originalRoll();
    facts.assert({
      subject: 'parcel:a', predicate: 'taxRate', value: 2.68,
      validFrom: '2025-01-01', validTo: '2026-01-01',
      recordedAt: '2026-03-03T00:00:00.000Z', source: 'hcad:2025-corrected',
    });
    await saveSnapshot(store, { graph: ownershipGraph(), facts });

    const back = (await loadSnapshot(store)).facts;
    expect(back.value('parcel:a', 'taxRate', AT_APPROVAL)).toBe(2.81);
    expect(back.value('parcel:a', 'taxRate', AT_NOW)).toBe(2.68);
  });

  it('keeps a correction recorded by a LATER run answerable at a past knownAt', async () => {
    // The property that justifies this module: the correction arrives in a run
    // that never saw the original, and the pair still resolves on both clocks.
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() }, { runId: 'run-1' });
    await saveSnapshot(store, { graph: ownershipGraph(), facts: correctedRoll() }, { runId: 'run-2' });

    const { facts } = await loadSnapshot(store);
    // What the committee saw in December 2025.
    expect(facts.value('parcel:a', 'taxRate', AT_APPROVAL)).toBe(2.81);
    // What is true today about the same 2025 period.
    expect(facts.value('parcel:a', 'taxRate', AT_NOW)).toBe(2.68);
  });

  it('surfaces the correction through corrections() after a reload', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    await saveSnapshot(store, { graph: ownershipGraph(), facts: correctedRoll() });

    const { facts } = await loadSnapshot(store);
    const moved = facts.corrections('2026-01-01T00:00:00.000Z');
    expect(moved).toHaveLength(1);
    expect(moved[0].from.value).toBe(2.81);
    expect(moved[0].to.value).toBe(2.68);
    expect(moved[0].to.source).toBe('hcad:2025-corrected');
  });

  it('preserves lineage and both timestamps verbatim, not just the value', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    const { facts } = await loadSnapshot(store);
    expect(facts.facts[0]).toEqual({
      subject: 'parcel:a', predicate: 'taxRate', value: 2.81,
      validFrom: '2025-01-01', validTo: '2026-01-01',
      recordedAt: '2025-02-01T00:00:00.000Z', source: 'hcad:2025', confidence: 1,
    });
  });

  it('does not stamp a reload time onto a fact that already has a transaction clock', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    const { facts } = await loadSnapshot(store);
    // A recordedAt of "now" would make the fact invisible to any past knownAt,
    // which is how an audit trail silently stops answering.
    expect(facts.value('parcel:a', 'taxRate', { validAt: '2025-06-01', knownAt: '2025-02-02' })).toBe(2.81);
  });
});

describe('persist — merge rather than replace', () => {
  it('keeps facts an earlier run recorded about other subjects', async () => {
    const store = new MemoryStore();
    const first = new FactStore();
    first.assert({
      subject: 'metro:houston', predicate: 'population', value: 7_340_000,
      validFrom: '2023-01-01', recordedAt: '2024-05-01T00:00:00.000Z', source: 'census:acs5:2023',
    });
    await saveSnapshot(store, { graph: new Graph(), facts: first });
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });

    const { facts, graph } = await loadSnapshot(store);
    expect(facts.size).toBe(2);
    expect(facts.value('metro:houston', 'population', { validAt: '2024-01-01', knownAt: '2026-01-01' })).toBe(7_340_000);
    expect(graph.getNode('parcel:a').props.situs).toBe('100 Main St');
  });

  it('unions nodes and edges across runs', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: new FactStore() });

    const second = new Graph();
    second.addNode({ id: 'parcel:b', type: 'Parcel', props: {} });
    second.addNode({ id: 'holdco:sunbelt', type: 'Entity', props: { fein: '12-3456789' } });
    second.addEdge({ from: 'parcel:b', to: 'holdco:sunbelt', type: 'owned_by' });
    await saveSnapshot(store, { graph: second, facts: new FactStore() });

    const { graph } = await loadSnapshot(store);
    expect(graph.stats.nodes).toBe(4);
    expect(graph.stats.edges).toBe(3);
    // Props upsert across runs instead of the later run blanking the earlier.
    expect(graph.getNode('holdco:sunbelt').props).toEqual({ name: 'SUNBELT HOLDINGS LLC', fein: '12-3456789' });
    expect(graph.portfolioOf('holdco:sunbelt').map((p) => p.id).sort()).toEqual(['parcel:a', 'parcel:b']);
  });

  it('answers the ownership query identically after a reload', async () => {
    const store = new MemoryStore();
    const before = ownershipGraph();
    await saveSnapshot(store, { graph: before, facts: new FactStore() });
    const { graph } = await loadSnapshot(store);
    expect(graph.beneficialOwners('parcel:a').map((o) => o.entity.id)).toEqual(
      before.beneficialOwners('parcel:a').map((o) => o.entity.id),
    );
    expect(graph.relatedParty('spe:a', 'holdco:sunbelt')).toBe(true);
  });

  it('does not duplicate facts when the same snapshot is saved twice', async () => {
    const store = new MemoryStore();
    const snapshot = { graph: ownershipGraph(), facts: originalRoll() };
    await saveSnapshot(store, snapshot);
    await saveSnapshot(store, snapshot);
    await saveSnapshot(store, snapshot);

    const { facts, graph } = await loadSnapshot(store);
    expect(facts.size).toBe(1);
    expect(graph.stats).toEqual({ nodes: 3, edges: 2, byType: { Parcel: 1, Entity: 2 }, byEdge: { owned_by: 1, controlled_by: 1 } });
  });

  it('never collapses two facts that differ only in when they were recorded', async () => {
    // Dedupe on (subject, predicate, validFrom) would swallow the correction —
    // the one row that makes the past knownAt answerable.
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: new Graph(), facts: originalRoll() });
    await saveSnapshot(store, { graph: new Graph(), facts: correctedRoll() });
    await saveSnapshot(store, { graph: new Graph(), facts: correctedRoll() });

    const { facts } = await loadSnapshot(store);
    expect(facts.history('parcel:a', 'taxRate')).toHaveLength(2);
  });

  it('merges into a live graph the caller already holds', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });

    const live = { graph: new Graph(), facts: correctedRoll() };
    live.graph.addNode({ id: 'parcel:b', type: 'Parcel', props: {} });
    const read = await loadSnapshot(store, { into: live });

    expect(read.present).toBe(true);
    expect(read.graph).toBe(live.graph);
    expect(live.graph.stats.nodes).toBe(4);
    expect(live.facts.value('parcel:a', 'taxRate', AT_APPROVAL)).toBe(2.81);
    expect(live.facts.value('parcel:a', 'taxRate', AT_NOW)).toBe(2.68);
  });

  it('leaves a live graph untouched when nothing was ever saved', async () => {
    const live = { graph: ownershipGraph(), facts: originalRoll() };
    const read = await loadSnapshot(new MemoryStore(), { into: live });
    expect(read.present).toBe(false);
    expect(read.graph).toBe(live.graph);
    expect(live.graph.stats.nodes).toBe(3);
    expect(live.facts.size).toBe(1);
  });

  it('replaces only when replacement is asked for explicitly', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    await saveSnapshot(store, { graph: new Graph(), facts: correctedRoll() }, { mode: 'replace' });

    const { graph, facts } = await loadSnapshot(store);
    expect(graph.stats.nodes).toBe(0);
    expect(facts.size).toBe(1);
    // The original is not gone from the store — replace demotes it to the fallback.
    expect(await raw(store, PREV)).not.toBeNull();
  });

  it('rejects an unknown save mode rather than guessing', async () => {
    await expect(saveSnapshot(new MemoryStore(), empty(), { mode: 'overwrite' }))
      .rejects.toThrow(/unknown save mode/);
  });
});

describe('persist — merge conflicts', () => {
  it('reports a node whose type two runs disagree about, and keeps the first', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: new FactStore() });

    const clashing = new Graph();
    clashing.addNode({ id: 'parcel:a', type: 'Building', props: {} });
    clashing.addNode({ id: 'tenant:x', type: 'Tenant', props: {} });
    clashing.addEdge({ from: 'tenant:x', to: 'parcel:a', type: 'leases' });
    const res = await saveSnapshot(store, { graph: clashing, facts: new FactStore() });

    expect(res.ok).toBe(true);
    expect(res.conflicts).toEqual([
      { kind: 'node-type', id: 'parcel:a', existing: 'Parcel', incoming: 'Building' },
    ]);
    const { graph } = await loadSnapshot(store);
    expect(graph.getNode('parcel:a').type).toBe('Parcel');
    // The rest of the disagreeing run still lands.
    expect(graph.getNode('tenant:x')).not.toBeNull();
  });

  it('counts what a merge added and what it recognised as already held', () => {
    const target = { graph: ownershipGraph(), facts: originalRoll() };
    const incoming = { graph: ownershipGraph(), facts: originalRoll() };
    incoming.graph.addNode({ id: 'parcel:b', type: 'Parcel', props: {} });
    incoming.facts.assert({
      subject: 'parcel:b', predicate: 'taxRate', value: 2.9,
      validFrom: '2025-01-01', recordedAt: '2025-02-01T00:00:00.000Z', source: 'hcad:2025',
    });

    expect(mergeInto(target, incoming)).toEqual({
      nodesAdded: 1, edgesAdded: 0, factsAdded: 1, factsSkipped: 1, conflicts: [],
    });
  });
});

describe('persist — corrupt and partially written payloads', () => {
  it('quarantines an unparseable payload instead of destroying it', async () => {
    const store = new MemoryStore();
    await store.set(KEY, '{"schemaVersion":2,"graph":{"nodes":[');

    const read = await loadSnapshot(store);
    expect(read.error).toBe('corrupt');
    expect(read.present).toBe(false);
    expect(read.graph).toBeNull();
    expect(read.quarantined).not.toBeNull();
    expect(await raw(store, read.quarantined)).toBe('{"schemaVersion":2,"graph":{"nodes":[');
    // The original key is copied, never moved: it may be the only copy there is.
    expect(await raw(store)).toBe('{"schemaVersion":2,"graph":{"nodes":[');
  });

  it('does not multiply quarantine copies of the same bad payload', async () => {
    const store = new MemoryStore();
    await store.set(KEY, 'not json');
    await loadSnapshot(store);
    await loadSnapshot(store);
    await loadSnapshot(store);
    const quarantined = (await store.list('')).filter((k) => k.includes(':corrupt:'));
    expect(quarantined).toHaveLength(1);
  });

  it('falls back to the last good snapshot when the live one is truncated', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    await saveSnapshot(store, { graph: ownershipGraph(), facts: correctedRoll() });
    const good = await raw(store);
    await store.set(KEY, good.slice(0, Math.floor(good.length / 2)));

    const read = await loadSnapshot(store);
    expect(read.error).toBe('corrupt');
    expect(read.recovered).toBe(true);
    expect(read.present).toBe(true);
    // The fallback is the previous save, so the original roll is still there.
    expect(read.facts.value('parcel:a', 'taxRate', AT_APPROVAL)).toBe(2.81);
  });

  it('does not lose the last good data when a run is saved after a corruption', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    await saveSnapshot(store, { graph: new Graph(), facts: new FactStore() });
    await store.set(KEY, '<html>502 Bad Gateway</html>');

    const res = await saveSnapshot(store, { graph: new Graph(), facts: correctedRoll() });
    expect(res.ok).toBe(true);
    expect(res.recovered).toBe(true);

    const { facts } = await loadSnapshot(store);
    expect(facts.value('parcel:a', 'taxRate', AT_APPROVAL)).toBe(2.81);
    expect(facts.value('parcel:a', 'taxRate', AT_NOW)).toBe(2.68);
  });

  it('detects a payload edited underneath the checksum', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    const tampered = JSON.parse(await raw(store));
    tampered.facts.facts[0].value = 9.99;
    await store.set(KEY, JSON.stringify(tampered));

    const read = await loadSnapshot(store);
    expect(read.error).toBe('corrupt');
    expect(read.recovered).toBe(false);
    expect(read.graph).toBeNull();
  });

  it('reads a payload whose keys a store reordered', async () => {
    // A document store may hand JSON back with its own key order. That is not
    // corruption, and a byte checksum would have condemned it.
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    const parsed = JSON.parse(await raw(store));
    parsed.facts.facts[0] = Object.fromEntries(
      Object.entries(parsed.facts.facts[0]).reverse(),
    );
    await store.set(KEY, JSON.stringify(parsed));

    const read = await loadSnapshot(store);
    expect(read.error).toBeNull();
    expect(read.facts.value('parcel:a', 'taxRate', AT_NOW)).toBe(2.81);
  });

  it('refuses to read a half-written payload as an empty snapshot', async () => {
    // The dangerous failure: `Graph.fromJSON(undefined)` yields an empty graph,
    // so a payload that lost its body would read as "the run observed nothing"
    // and the next merge would carry that emptiness forward as truth.
    const store = new MemoryStore();
    await store.set(KEY, JSON.stringify({
      schemaVersion: SCHEMA_VERSION, snapshotId: 'default', savedAt: '2026-03-03T00:00:00.000Z',
      counts: { nodes: 3, edges: 2, facts: 1 },
    }));

    const read = await loadSnapshot(store);
    expect(read.error).toBe('corrupt');
    expect(read.present).toBe(false);
  });

  it('treats a fact with no lineage as corruption, not as a loadable fact', async () => {
    const store = new MemoryStore();
    await store.set(KEY, JSON.stringify({
      graph: { nodes: [], edges: [] },
      facts: { facts: [{ subject: 'parcel:a', predicate: 'taxRate', value: 2.81, validFrom: '2025-01-01', recordedAt: '2025-02-01T00:00:00.000Z' }] },
    }));
    expect((await loadSnapshot(store)).error).toBe('corrupt');
  });

  it('treats a fact with no recordedAt as corruption rather than dating it now', async () => {
    const store = new MemoryStore();
    await store.set(KEY, JSON.stringify({
      graph: { nodes: [], edges: [] },
      facts: { facts: [{ subject: 'parcel:a', predicate: 'taxRate', value: 2.81, validFrom: '2025-01-01', source: 'hcad:2025' }] },
    }));
    expect((await loadSnapshot(store)).error).toBe('corrupt');
  });

  it('rejects a payload whose row counts do not match its body', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    const short = JSON.parse(await raw(store));
    short.facts.facts = [];
    short.checksum = null;
    await store.set(KEY, JSON.stringify(short));
    expect((await loadSnapshot(store)).error).toBe('corrupt');
  });

  it('rejects an edge whose endpoint the payload never defined', async () => {
    const store = new MemoryStore();
    await store.set(KEY, JSON.stringify({
      graph: { nodes: [{ id: 'parcel:a', type: 'Parcel', props: {} }], edges: [{ from: 'parcel:a', to: 'spe:missing', type: 'owned_by', props: {} }] },
      facts: { facts: [] },
    }));
    expect((await loadSnapshot(store)).error).toBe('corrupt');
  });
});

describe('persist — values JSON does not round-trip unchanged', () => {
  // The checksum was computed over the live objects and verified over the
  // JSON-parsed ones. Those disagree for anything JSON.stringify transforms: a
  // key whose value is `undefined` is dropped, a Date becomes an ISO string.
  // Every save carrying one wrote a payload it had already made unreadable, and
  // reported ok. The run was then quarantined on the next load and never named.
  const poisons = [
    {
      label: 'a fact asserted without a value, which assert() permits',
      facts: () => {
        const f = new FactStore();
        f.assert({
          subject: 'parcel:b', predicate: 'floodZone',
          validFrom: '2026-01-01', recordedAt: '2026-03-03T00:00:00.000Z', source: 'fema:2026',
        });
        return f;
      },
      graph: () => new Graph(),
    },
    {
      label: 'a Date as a fact value',
      facts: () => {
        const f = new FactStore();
        f.assert({
          subject: 'parcel:a', predicate: 'lastSale', value: new Date('2026-01-05'),
          validFrom: '2026-01-05', recordedAt: '2026-03-03T00:00:00.000Z', source: 'deed',
        });
        return f;
      },
      graph: () => new Graph(),
    },
    {
      label: 'a Date on a node prop',
      facts: () => new FactStore(),
      graph: () => {
        const g = new Graph();
        g.addNode({ id: 'tx:1', type: 'Transaction', props: { closed: new Date('2026-02-02') } });
        return g;
      },
    },
    {
      label: 'an undefined field nested inside a fact value',
      facts: () => {
        const f = new FactStore();
        f.assert({
          subject: 'parcel:a', predicate: 'taxAppeal', value: { rate: 2.81, appealedBy: undefined },
          validFrom: '2026-01-01', recordedAt: '2026-03-03T00:00:00.000Z', source: 'hcad',
        });
        return f;
      },
      graph: () => new Graph(),
    },
  ];

  poisons.forEach(({ label, facts, graph }) => {
    it(`survives ${label}`, async () => {
      const store = new MemoryStore();
      await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() }, { runId: 'run-1' });
      const save = await saveSnapshot(store, { graph: graph(), facts: facts() }, { runId: 'run-2' });
      expect(save.ok).toBe(true);

      const loaded = await loadSnapshot(store);
      expect(loaded.error).toBeNull();
      expect(loaded.present).toBe(true);
      expect(loaded.recovered).toBe(false);
      expect(loaded.quarantined).toBeNull();
      // run-2 is still there, not quarantined behind a checksum it never matched.
      expect(loaded.facts.size).toBe(originalRoll().size + facts().size);
    });
  });

  it('refuses rather than reports ok when a payload cannot be read back', async () => {
    // Belt and braces on the above: `ok: true` has to mean readable. A store is
    // never handed a payload this module has not decoded first.
    const store = new MemoryStore();
    const circular = new Graph();
    const props = {};
    props.self = props;
    circular.addNode({ id: 'loop:1', type: 'Parcel', props });
    const save = await saveSnapshot(store, { graph: circular, facts: new FactStore() });
    expect(save.ok).toBe(false);
    expect(await raw(store)).toBeNull();
  });
});

describe('persist — replace is held to the same promises as merge', () => {
  it('refuses to overwrite a payload from a newer schema', async () => {
    // The version refusal lived only on the merge path, so the one mode that
    // actually destroys data was the one that did not check. There is no :prev
    // and no quarantine on a first replace, so the newer build's snapshot — and
    // the fields this build cannot see — were unrecoverable.
    const store = new MemoryStore();
    const future = JSON.stringify({
      schemaVersion: SCHEMA_VERSION + 1, savedAt: '2027-01-01T00:00:00.000Z',
      graph: { nodes: [], edges: [] }, facts: { facts: [] }, embargoes: [{ id: 'x' }],
    });
    await store.set(KEY, future);

    const result = await saveSnapshot(store, empty(), { mode: 'replace' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unsupported-version');
    expect(await raw(store)).toBe(future);
  });

  it('copies a corrupt payload aside before overwriting it', async () => {
    const store = new MemoryStore();
    await store.set(KEY, '<html>502 Bad Gateway</html>');
    const result = await saveSnapshot(store, empty(), { mode: 'replace' });

    expect(result.ok).toBe(true);
    expect(result.quarantined).not.toBeNull();
    expect(await raw(store, result.quarantined)).toBe('<html>502 Bad Gateway</html>');
  });
});

describe('persist — a snapshot whose live key is gone', () => {
  async function twoSavesThenEvict() {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() }, { runId: 'run-1' });
    await saveSnapshot(store, { graph: new Graph(), facts: correctedRoll() }, { runId: 'run-2' });
    store.items.delete(KEY);          // store eviction, or a crash mid-rewrite
    return store;
  }

  it('reads the fallback instead of reporting that nothing was ever saved', async () => {
    // 'nothing was ever saved' tells the caller to seed, and the next save then
    // overwrites the only surviving copy. That conflation is the one thing this
    // adapter's docblock promises it never makes.
    const store = await twoSavesThenEvict();
    const loaded = await loadSnapshot(store);

    expect(loaded.present).toBe(true);
    expect(loaded.error).toBe('missing');
    expect(loaded.recovered).toBe(true);
    expect(loaded.facts.value('parcel:a', 'taxRate', AT_APPROVAL)).toBe(2.81);
  });

  it('shows it in the listing rather than hiding it behind the missing key', async () => {
    const store = await twoSavesThenEvict();
    const listed = await listSnapshots(store);
    expect(listed.map((x) => x.id)).toEqual(['default']);
    expect(listed[0].error).toBe('missing');
    expect(listed[0].recovered).toBe(true);
  });
});

describe('persist — schema version', () => {
  it('migrates the bare {graph, facts} shape that predates the envelope', async () => {
    const store = new MemoryStore();
    await store.set(KEY, JSON.stringify({
      graph: ownershipGraph().toJSON(),
      facts: originalRoll().toJSON(),
    }));

    const read = await loadSnapshot(store);
    expect(read.migrated).toBe(true);
    expect(read.meta.schemaVersion).toBe(1);
    // Unknown, and it stays unknown: a load-time savedAt would misdate every
    // comparison made against this snapshot.
    expect(read.meta.savedAt).toBeNull();
    expect(read.facts.value('parcel:a', 'taxRate', AT_APPROVAL)).toBe(2.81);
    expect(read.graph.beneficialOwners('parcel:a')[0].entity.id).toBe('holdco:sunbelt');
  });

  it('leaves a migrated payload at the current version once resaved', async () => {
    const store = new MemoryStore();
    await store.set(KEY, JSON.stringify({ graph: new Graph().toJSON(), facts: originalRoll().toJSON() }));
    await saveSnapshot(store, { graph: ownershipGraph(), facts: correctedRoll() });

    const read = await loadSnapshot(store);
    expect(read.migrated).toBe(false);
    expect(read.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(read.facts.size).toBe(2);
  });

  it('defaults an absent confidence to unknown, not to certainty', async () => {
    const store = new MemoryStore();
    await store.set(KEY, JSON.stringify({
      graph: { nodes: [], edges: [] },
      facts: { facts: [{ subject: 'parcel:a', predicate: 'taxRate', value: 2.81, validFrom: '2025-01-01', recordedAt: '2025-02-01T00:00:00.000Z', source: 'hcad:2025' }] },
    }));
    const { facts } = await loadSnapshot(store);
    expect(facts.facts[0].confidence).toBeNull();
  });

  it('keeps the integrity fields a payload carries when it loses its version stamp', async () => {
    // Migration built a fresh v1 envelope and threw away the checksum, counts
    // and save time sitting in the payload, so losing a single field turned off
    // every check: a tampered body then loaded clean, and a dated snapshot
    // sorted last as though it were undated.
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() },
      { savedAt: new Date('2026-03-01T00:00:00.000Z') });

    const payload = JSON.parse(await raw(store));
    delete payload.schemaVersion;
    payload.facts.facts[0].value = 9.99;             // the tamper
    await store.set(KEY, JSON.stringify(payload));

    const read = await loadSnapshot(store);
    expect(read.error).toBe('corrupt');
    expect(read.present).toBe(false);

    // And with the body left alone, the save time survives the migration.
    const clean = JSON.parse(await raw(store, PREV) ?? 'null');
    expect(clean).toBeNull();                        // first save, so no fallback yet
    const untampered = JSON.parse(JSON.stringify(payload));
    untampered.facts.facts[0].value = 2.81;
    await store.set(KEY, JSON.stringify(untampered));
    const ok = await loadSnapshot(store);
    expect(ok.error).toBeNull();
    expect(ok.migrated).toBe(true);
    expect(ok.meta.savedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('refuses a payload from a newer schema instead of round-tripping it lossily', async () => {
    const store = new MemoryStore();
    const future = JSON.stringify({
      schemaVersion: SCHEMA_VERSION + 1, savedAt: '2027-01-01T00:00:00.000Z',
      graph: { nodes: [], edges: [] }, facts: { facts: [] }, embargoes: [{ id: 'x' }],
    });
    await store.set(KEY, future);

    const read = await loadSnapshot(store);
    expect(read.error).toBe('unsupported-version');
    expect(read.graph).toBeNull();
    // Newer is not broken: nothing is quarantined and nothing is rewritten.
    expect(read.quarantined).toBeNull();

    const res = await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unsupported-version');
    expect(await raw(store)).toBe(future);
  });
});

describe('persist — store contract', () => {
  it('works against a synchronous store', async () => {
    const items = new Map();
    const sync = {
      get: (k) => (items.has(k) ? items.get(k) : null),
      set: (k, v) => { items.set(k, String(v)); },
      list: (p) => [...items.keys()].filter((k) => k.startsWith(p)),
    };
    await saveSnapshot(sync, { graph: ownershipGraph(), facts: originalRoll() });
    const read = await loadSnapshot(sync);
    expect(read.facts.value('parcel:a', 'taxRate', AT_NOW)).toBe(2.81);
  });

  it('names the method a store is missing', async () => {
    await expect(loadSnapshot({ get: () => null, set: () => {} })).rejects.toThrow(/list\(\)/);
  });

  it('reports a write failure without throwing, leaving the stored data readable', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() });
    const before = await raw(store);

    const readOnly = {
      get: (k) => store.get(k),
      set: () => { throw new Error('EACCES'); },
      list: (p) => store.list(p),
    };
    const res = await saveSnapshot(readOnly, { graph: new Graph(), facts: correctedRoll() });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('write-failed');
    expect(await raw(store)).toBe(before);
  });

  it('distinguishes a full store from a broken one', async () => {
    const quotaError = new Error('exceeded');
    quotaError.name = 'QuotaExceededError';
    const store = {
      get: () => null,
      set: () => { throw quotaError; },
      list: () => [],
    };
    expect((await saveSnapshot(store, empty())).error).toBe('quota');
  });

  it('reports an unreadable store rather than treating it as never saved', async () => {
    const store = {
      get: () => { throw new Error('connection reset'); },
      set: () => {},
      list: () => [],
    };
    const read = await loadSnapshot(store);
    expect(read.error).toBe('unavailable');
    expect(read.present).toBe(false);
  });

  it('rejects a snapshot id that could collide with the key grammar', async () => {
    const store = new MemoryStore();
    await expect(loadSnapshot(store, { id: 'default:corrupt:0' })).rejects.toThrow(/invalid snapshot id/);
    await expect(saveSnapshot(store, empty(), { id: '' })).rejects.toThrow(/invalid snapshot id/);
  });

  it('rejects a snapshot that is not a graph and a fact store', async () => {
    await expect(saveSnapshot(new MemoryStore(), { graph: {}, facts: {} }))
      .rejects.toThrow(/Graph and a FactStore/);
  });
});

describe('persist — listing', () => {
  it('sorts a snapshot with no known save time last, not first', async () => {
    // An unknown savedAt used to be stringified to the literal "null", which
    // then read as a save time and sorted as the NEWEST snapshot — the exact
    // inversion the comparator exists to prevent.
    const store = new MemoryStore();
    await saveSnapshot(store, empty(), { id: 'undated', savedAt: null });
    await saveSnapshot(store, empty(), { id: 'dated', savedAt: new Date('2026-03-01T00:00:00.000Z') });

    const listed = await listSnapshots(store);
    expect(listed.map((x) => x.id)).toEqual(['dated', 'undated']);
    expect(listed.find((x) => x.id === 'undated').savedAt).toBeNull();
  });

  it('lists snapshots newest first, without their fallbacks or quarantines', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() }, { id: 'nightly', runId: 'run-1', savedAt: '2026-03-01T00:00:00.000Z' });
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() }, { id: 'nightly', savedAt: '2026-03-02T00:00:00.000Z' });
    await saveSnapshot(store, { graph: new Graph(), facts: new FactStore() }, { id: 'adhoc', savedAt: '2026-03-05T00:00:00.000Z' });

    const listed = await listSnapshots(store);
    expect(listed.map((s) => s.id)).toEqual(['adhoc', 'nightly']);
    expect(listed[1]).toEqual({
      id: 'nightly', savedAt: '2026-03-02T00:00:00.000Z', runId: null,
      schemaVersion: SCHEMA_VERSION, counts: { nodes: 3, edges: 2, facts: 1 }, error: null,
      recovered: false,
    });
  });

  it('flags an unreadable snapshot rather than hiding it or reporting it as empty', async () => {
    const store = new MemoryStore();
    await saveSnapshot(store, { graph: ownershipGraph(), facts: originalRoll() }, { id: 'good', savedAt: '2026-03-01T00:00:00.000Z' });
    await store.set(snapshotKey('broken'), 'not json');

    const listed = await listSnapshots(store);
    const broken = listed.find((s) => s.id === 'broken');
    expect(broken.error).toBe('corrupt');
    // Zeros here would read as an empty snapshot and invite an overwrite.
    expect(broken.counts).toBeNull();
    expect(broken.savedAt).toBeNull();
    expect(listed[0].id).toBe('good');
  });
});
