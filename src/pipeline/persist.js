/**
 * Durable snapshots of the pipeline's canonical layer.
 *
 * `Graph.toJSON()` and `FactStore.toJSON()` have existed since the canonical
 * layer was written and nothing outside their tests calls them: a run builds a
 * graph, projects it into a market data file, and drops it on the floor. Every
 * capability that compares this run to the last one — parcels that appeared
 * since March, an assessor correction that moves an already-approved
 * underwriting, ownership that changed hands — needs the previous run to still
 * exist. This module is that missing half.
 *
 * Three properties are load-bearing:
 *
 *   merge, not replace   Runs are incremental. Saving a run that touched one
 *                        county must not delete the other twelve. Save reads
 *                        what is stored, unions the run into it, and writes the
 *                        union.
 *
 *   both clocks survive  A fact's `recordedAt` is evidence, not a modification
 *                        timestamp. Facts are rebuilt verbatim and never
 *                        re-`assert`ed on the way in, because `assert()`
 *                        defaults a missing `recordedAt` to now — which would
 *                        quietly move a fact's transaction clock forward to the
 *                        moment of a reload and destroy the answer to "what did
 *                        the model see when the committee approved this deal?".
 *
 *   a bad payload costs  A truncated, hand-edited or half-written payload is
 *   nothing              quarantined under its own key (never deleted, never
 *                        overwritten in place) and the previous good snapshot,
 *                        kept at `:prev` by every save, is read instead.
 *
 * Storage-agnostic by injection, exactly as `transport.js` takes a `fetchImpl`:
 * the caller passes a store with get/set/list, so the same code path runs
 * against localStorage, S3, a table, or `MemoryStore` in tests. Every store call
 * is awaited, so a synchronous store works unchanged.
 *
 * The store contract:
 *
 *   get(key)      -> string | null   null ONLY when the key was never written.
 *                                    A store that returns '' or undefined for a
 *                                    missing key breaks the never-saved /
 *                                    saved-empty distinction below.
 *   set(key, val) -> void            val is always a string.
 *   list(prefix)  -> string[]        keys beginning with prefix, any order.
 */

import { Graph } from './graph';
import { FactStore } from './temporal';

export const SCHEMA_VERSION = 2;
export const KEY_PREFIX = 'cre-pipeline:snapshot:';

/**
 * Snapshot ids live in a key grammar where ':' separates the id from the
 * ':prev' and ':corrupt:' suffixes. An id containing ':' could therefore name a
 * quarantined copy, and a later load would read known-bad data as if it were
 * live — so the character is refused at the door rather than escaped.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const snapshotKey = (id) => `${KEY_PREFIX}${id}`;
const previousKey = (id) => `${snapshotKey(id)}:prev`;
const quarantineKey = (id, raw) => `${snapshotKey(id)}:corrupt:${checksum(raw)}`;

/** Reference store. Also the shape a real adapter has to implement. */
export class MemoryStore {
  constructor(entries = {}) {
    this.items = new Map(Object.entries(entries));
  }

  async get(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }

  async set(key, value) {
    this.items.set(key, String(value));
  }

  async list(prefix = '') {
    return [...this.items.keys()].filter((k) => k.startsWith(prefix));
  }

  get size() { return this.items.size; }
}

/**
 * Persist a graph and fact store.
 *
 * @param {{get:Function,set:Function,list:Function}} store
 * @param {{graph:Graph, facts:FactStore}} snapshot
 * @param {Object} [options]
 * @param {string} [options.id]      snapshot name; several may coexist
 * @param {string} [options.runId]   the run that produced this, for lineage
 * @param {Date|string} [options.savedAt]
 * @param {'merge'|'replace'} [options.mode]
 *   'merge' (default) unions with what is already stored. 'replace' is the
 *   explicit, destructive choice — it exists for a rebuild from source, and is
 *   never what an incremental run wants.
 * @returns {Promise<{ok:boolean, error:string|null, merged:boolean,
 *   recovered:boolean, quarantined:string|null, conflicts:Array, counts:Object|null}>}
 */
export async function saveSnapshot(store, { graph, facts } = {}, options = {}) {
  const { id = 'default', runId = null, savedAt = new Date(), mode = 'merge' } = options;
  assertStore(store);
  assertId(id);
  if (!isGraph(graph) || !isFactStore(facts)) {
    throw new Error('saveSnapshot needs a Graph and a FactStore');
  }
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error(`unknown save mode: ${mode}`);
  }

  const fail = (error) => ({
    ok: false, error, merged: false, recovered: false,
    quarantined: null, conflicts: [], counts: null,
  });

  let outgoing = { graph, facts };
  let merged = false;
  let recovered = false;
  let quarantined = null;
  let conflicts = [];
  let demote = null;

  if (mode === 'merge') {
    let prior;
    try {
      prior = await readKey(store, id);
    } catch {
      return fail('unavailable');
    }
    if (prior.error === 'unsupported-version') {
      // Written by a newer build that knows fields this one would silently drop.
      // Merging would round-trip the payload through an older schema and delete
      // them, so the run is refused instead — a failed save is recoverable, a
      // quietly truncated one is not.
      return fail('unsupported-version');
    }
    quarantined = prior.quarantined;
    recovered = prior.recovered;
    if (prior.graph) {
      const target = { graph: prior.graph, facts: prior.facts };
      const report = mergeInto(target, { graph, facts });
      conflicts = report.conflicts;
      outgoing = target;
      merged = true;
      // Only a payload that verified is worth keeping as the fallback. Demoting
      // a corrupt one would overwrite the last good copy with the garbage that
      // made the fallback necessary.
      demote = prior.raw;
    }
  } else {
    // Replace is the only path that destroys what is stored, so it makes the
    // same two promises the merge path makes. Without them a newer build's
    // snapshot was overwritten with no version refusal, no `:prev` copy and no
    // quarantine, and a corrupt one was deleted rather than copied aside.
    const raw = await tolerant(() => store.get(snapshotKey(id)));
    if (raw != null) {
      const prior = decode(raw);
      if (prior.ok) {
        demote = raw;
      } else if (prior.error === 'unsupported-version') {
        return fail('unsupported-version');
      } else {
        quarantined = quarantineKey(id, raw);
        await tolerant(() => store.set(quarantined, raw));
      }
    }
  }

  const live = { graph: outgoing.graph.toJSON(), facts: outgoing.facts.toJSON() };
  // Canonicalise through JSON before hashing or counting. The checksum is
  // verified on read against the PARSED payload, so it has to be taken over
  // the form the store will hold, not over the live objects: JSON.stringify
  // drops a key whose value is `undefined` and turns a Date into a string, so
  // hashing the live object condemned every snapshot carrying either — while
  // the save that wrote it reported ok. This also catches a value that cannot
  // be serialised at all instead of overflowing the stack on a cycle.
  let body;
  try {
    body = JSON.parse(JSON.stringify(live));
  } catch {
    return { ...fail('unserializable'), quarantined, recovered };
  }

  const counts = countsOf(body);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: id,
    runId,
    savedAt: iso(savedAt),
    counts,
    checksum: checksum(stableStringify(body)),
    ...body,
  };
  const serialized = JSON.stringify(payload);

  // One decode, bought deliberately: `ok: true` has to mean the snapshot can be
  // read back. A payload that verified at write time and failed at read time
  // reported success, quarantined itself on the next load, and named no run.
  if (!decode(serialized).ok) {
    return { ...fail('unreadable'), quarantined, recovered };
  }

  try {
    // Order matters: the fallback is written before the live key, so a crash
    // between the two leaves the old snapshot readable from both places rather
    // than from neither.
    if (demote !== null) await store.set(previousKey(id), demote);
    await store.set(snapshotKey(id), serialized);
  } catch (e) {
    return {
      ...fail(e && e.name === 'QuotaExceededError' ? 'quota' : 'write-failed'),
      quarantined, recovered,
    };
  }

  return { ok: true, error: null, merged, recovered, quarantined, conflicts, counts };
}

/**
 * Read a snapshot back.
 *
 * @param {Object} store
 * @param {Object} [options]
 * @param {string} [options.id]
 * @param {{graph:Graph, facts:FactStore}} [options.into]
 *   When given, the stored snapshot is merged into these live instances rather
 *   than returned beside them, so a long-running process can top up the graph
 *   it already holds without losing anything either side knows.
 * @returns {Promise<{present:boolean, graph:Graph|null, facts:FactStore|null,
 *   meta:Object|null, error:string|null, migrated:boolean, recovered:boolean,
 *   quarantined:string|null, conflicts:Array}>}
 *
 * `present: false` means nothing was ever saved under this id — the caller
 * should seed. `present: true` with an empty graph means a run genuinely
 * observed nothing, and re-seeding it would resurrect data somebody deleted.
 * The two are not the same answer and this adapter never conflates them.
 */
export async function loadSnapshot(store, options = {}) {
  const { id = 'default', into = null } = options;
  assertStore(store);
  assertId(id);

  const empty = {
    present: false, graph: null, facts: null, meta: null,
    error: null, migrated: false, recovered: false, quarantined: null, conflicts: [],
  };

  let read;
  try {
    read = await readKey(store, id);
  } catch {
    return { ...empty, error: 'unavailable' };
  }

  if (!read.graph) {
    if (into) return { ...empty, ...unwrap(into), error: read.error, quarantined: read.quarantined };
    return { ...empty, error: read.error, quarantined: read.quarantined };
  }

  if (into) {
    if (!isGraph(into.graph) || !isFactStore(into.facts)) {
      throw new Error('loadSnapshot `into` needs a Graph and a FactStore');
    }
    const report = mergeInto(into, { graph: read.graph, facts: read.facts });
    return {
      present: true, ...unwrap(into), meta: read.meta, error: read.error,
      migrated: read.migrated, recovered: read.recovered,
      quarantined: read.quarantined, conflicts: report.conflicts,
    };
  }

  return {
    present: true, graph: read.graph, facts: read.facts, meta: read.meta,
    error: read.error, migrated: read.migrated, recovered: read.recovered,
    quarantined: read.quarantined, conflicts: [],
  };
}

/**
 * Every stored snapshot, newest first, with the ones that no longer decode
 * flagged rather than omitted — an operator cannot fix a snapshot whose
 * existence the listing hides.
 *
 * @returns {Promise<Array<{id:string, savedAt:string|null, runId:string|null,
 *   schemaVersion:number|null, counts:Object|null, error:string|null}>>}
 */
export async function listSnapshots(store) {
  assertStore(store);
  const keys = await store.list(KEY_PREFIX);
  const ids = new Set();
  const PREV_SUFFIX = ':prev';
  for (const key of keys) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const rest = key.slice(KEY_PREFIX.length);
    if (!rest.includes(':')) ids.add(rest);
    // A snapshot whose live key has been evicted still exists at ':prev'. A
    // listing that hides it lets an operator overwrite the only surviving copy
    // without ever being told there was one.
    else if (rest.endsWith(PREV_SUFFIX)) ids.add(rest.slice(0, -PREV_SUFFIX.length));
  }

  const out = [];
  for (const id of ids) {
    let raw = await tolerant(() => store.get(snapshotKey(id)));
    let recovered = false;
    if (raw == null) {
      raw = await tolerant(() => store.get(previousKey(id)));
      recovered = raw != null;
    }
    if (raw == null) continue;
    const decoded = decode(raw);
    out.push(decoded.ok
      ? {
        id,
        savedAt: decoded.meta.savedAt,
        runId: decoded.meta.runId,
        schemaVersion: decoded.meta.schemaVersion,
        counts: decoded.meta.counts,
        error: recovered ? 'missing' : null,
        recovered,
      }
      // Unknowns stay null; a listing that reports zero nodes for an unreadable
      // snapshot reads as "empty" and invites someone to overwrite it.
      : { id, savedAt: null, runId: null, schemaVersion: null, counts: null, error: decoded.error, recovered });
  }
  return out.sort(bySavedAtDesc);
}

/**
 * Union `incoming` into `target`, in place. Returns what changed.
 *
 * Nodes and edges upsert through the graph's own idempotent adders. Facts are
 * appended unless byte-identical to one already held.
 */
export function mergeInto(target, incoming) {
  if (!isGraph(target?.graph) || !isFactStore(target?.facts)) {
    throw new Error('mergeInto needs a target { graph, facts }');
  }
  const conflicts = [];
  let nodesAdded = 0;
  let edgesAdded = 0;
  let factsAdded = 0;
  let factsSkipped = 0;

  for (const node of incoming.graph.nodes.values()) {
    const existing = target.graph.getNode(node.id);
    if (existing && existing.type !== node.type) {
      // Two runs disagree about what this id *is*. `addNode` throws here, which
      // would abandon the merge half-applied; instead the earlier node stands
      // and the disagreement is reported, because letting a Parcel become a
      // Building silently changes every ownership answer hanging off it.
      conflicts.push({ kind: 'node-type', id: node.id, existing: existing.type, incoming: node.type });
      continue;
    }
    if (!existing) nodesAdded++;
    target.graph.addNode({ id: node.id, type: node.type, props: { ...node.props } });
  }

  for (const edge of incoming.graph.edges) {
    if (!target.graph.getNode(edge.from) || !target.graph.getNode(edge.to)) {
      conflicts.push({ kind: 'dangling-edge', type: edge.type, from: edge.from, to: edge.to });
      continue;
    }
    const before = target.graph.edges.length;
    target.graph.addEdge({ from: edge.from, to: edge.to, type: edge.type, props: { ...edge.props } });
    if (target.graph.edges.length > before) edgesAdded++;
  }

  const seen = new Set(target.facts.facts.map(factIdentity));
  for (const fact of incoming.facts.facts) {
    const identity = factIdentity(fact);
    if (seen.has(identity)) { factsSkipped++; continue; }
    seen.add(identity);
    // Pushed rather than re-asserted: `assert()` stamps a missing `recordedAt`
    // with now, and a merge that moves transaction clocks forward is a merge
    // that has erased the audit trail.
    target.facts.facts.push({ ...fact });
    factsAdded++;
  }

  return { nodesAdded, edgesAdded, factsAdded, factsSkipped, conflicts };
}

/**
 * A fact's identity for dedupe: the whole tuple, both clocks included.
 *
 * Keying on (subject, predicate, validFrom) instead would classify a
 * retroactive correction as a duplicate of the value it corrects and drop it on
 * the second save — deleting precisely the history the second clock exists to
 * keep. Two facts equal in every field carry no information apart, so
 * collapsing those is lossless.
 */
function factIdentity(f) {
  return stableStringify([
    f.subject, f.predicate, f.validFrom, f.validTo ?? null,
    f.recordedAt, f.source, f.confidence ?? null, f.value,
  ]);
}

/** Read, verify, and fall back to the previous good copy when the live key is bad. */
async function readKey(store, id) {
  const raw = await store.get(snapshotKey(id));
  const absent = {
    graph: null, facts: null, meta: null, raw: null,
    error: null, migrated: false, recovered: false, quarantined: null,
  };
  if (raw === null || raw === undefined) {
    // The live key can go without the payload going: a store eviction, or a
    // crash on a truncate-then-write store. Reporting that as "nothing was ever
    // saved" is the one conflation this adapter promises not to make — the
    // caller re-seeds, and the next save overwrites the copy that survived.
    const orphanRaw = await tolerant(() => store.get(previousKey(id)));
    if (orphanRaw != null) {
      const orphan = decode(orphanRaw);
      if (orphan.ok) {
        return {
          graph: orphan.graph, facts: orphan.facts, meta: orphan.meta, raw: orphanRaw,
          error: 'missing', migrated: orphan.migrated, recovered: true, quarantined: null,
        };
      }
    }
    return absent;
  }

  const decoded = decode(raw);
  if (decoded.ok) {
    return {
      graph: decoded.graph, facts: decoded.facts, meta: decoded.meta, raw,
      error: null, migrated: decoded.migrated, recovered: false, quarantined: null,
    };
  }
  if (decoded.error === 'unsupported-version') {
    // Not damaged, just ahead of us. Quarantining it would imply it is garbage.
    return { ...absent, error: 'unsupported-version' };
  }

  // Keyed by content hash, not by clock: re-reading the same broken payload on
  // every load must not fill the store with identical quarantine copies.
  const quarantined = quarantineKey(id, raw);
  await tolerant(() => store.set(quarantined, raw));

  const prevRaw = await tolerant(() => store.get(previousKey(id)));
  if (prevRaw != null) {
    const prev = decode(prevRaw);
    if (prev.ok) {
      return {
        graph: prev.graph, facts: prev.facts, meta: prev.meta, raw: prevRaw,
        error: 'corrupt', migrated: prev.migrated, recovered: true, quarantined,
      };
    }
  }
  return { ...absent, error: 'corrupt', quarantined };
}

/**
 * Parse and validate one stored payload.
 * @returns {{ok:true, graph:Graph, facts:FactStore, meta:Object, migrated:boolean}
 *          |{ok:false, error:string, reason:string}}
 */
function decode(raw) {
  const bad = (reason, error = 'corrupt') => ({ ok: false, error, reason });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad('not parseable as JSON');
  }

  const migration = migrate(parsed);
  if (!migration) return bad('not a snapshot payload');
  if (migration.unsupported) {
    return bad(`schema v${migration.unsupported} was written by a newer build`, 'unsupported-version');
  }
  const env = migration.envelope;

  // A payload missing its graph or facts entirely is a half-written file, and
  // `Graph.fromJSON(undefined)` would hand back an empty graph — i.e. it would
  // read as "this run observed nothing" instead of "this file is truncated".
  if (!env.graph || !Array.isArray(env.graph.nodes) || !Array.isArray(env.graph.edges)) {
    return bad('graph section missing or malformed');
  }
  if (!env.facts || !Array.isArray(env.facts.facts)) {
    return bad('facts section missing or malformed');
  }

  if (env.checksum) {
    const actual = checksum(stableStringify({ graph: env.graph, facts: env.facts }));
    if (actual !== env.checksum) return bad('checksum does not match the body');
  }

  let graph;
  let facts;
  try {
    graph = Graph.fromJSON(env.graph);
    facts = factStoreFrom(env.facts);
  } catch (e) {
    return bad(e.message);
  }

  const counts = { nodes: graph.nodes.size, edges: graph.edges.length, facts: facts.size };
  if (env.counts && (env.counts.nodes !== counts.nodes
    || env.counts.edges !== counts.edges
    || env.counts.facts !== counts.facts)) {
    return bad('row counts do not match the declared counts');
  }

  return {
    ok: true,
    graph,
    facts,
    migrated: migration.migrated,
    meta: {
      schemaVersion: env.schemaVersion,
      snapshotId: env.snapshotId ?? null,
      runId: env.runId ?? null,
      savedAt: env.savedAt ?? null,
      counts,
    },
  };
}

/**
 * Bring a stored payload up to the current schema.
 *
 * v1: a bare `{graph, facts}` — what `JSON.stringify({graph, facts})` produces
 *     from the two toJSON()s, which is what anyone persisting this by hand
 *     before this module existed would have written. No envelope, so `savedAt`
 *     is genuinely unknown and stays null rather than being backfilled with a
 *     load time that would misdate every comparison made against it.
 * v2: an envelope carrying schema version, lineage, counts and a checksum.
 */
function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  if (parsed.schemaVersion === SCHEMA_VERSION) return { envelope: parsed, migrated: false };

  if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > SCHEMA_VERSION) {
    return { unsupported: parsed.schemaVersion };
  }

  if (parsed.schemaVersion === undefined && parsed.graph && parsed.facts) {
    return {
      migrated: true,
      envelope: {
        schemaVersion: 1,
        snapshotId: typeof parsed.snapshotId === 'string' ? parsed.snapshotId : null,
        runId: typeof parsed.runId === 'string' ? parsed.runId : null,
        // A hand-written v1 payload has no save time and it stays unknown. One
        // that carries a save time keeps it: discarding a fact that is sitting
        // in the payload sorts a dated snapshot last as though it were undated.
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
        // And it keeps whatever integrity fields it carries. Discarding them
        // turned the loss of one key into the loss of every check: strip
        // `schemaVersion` from a v2 payload and a tampered body loaded clean.
        counts: parsed.counts && typeof parsed.counts === 'object' ? parsed.counts : null,
        checksum: typeof parsed.checksum === 'string' ? parsed.checksum : null,
        graph: parsed.graph,
        facts: parsed.facts,
      },
    };
  }
  return null;
}

/**
 * Rebuild a fact store from a payload without going through `assert()`.
 *
 * The validation is deliberately the same set of rules `assert()` enforces —
 * a fact with no source cannot be defended in a memo, and one whose valid
 * window ends before it begins is nonsense — but the stored clocks are carried
 * across untouched. Anything failing is thrown, which makes the whole payload
 * corrupt: dropping the offending row instead would change a bitemporal answer
 * with nothing on screen to say so.
 */
function factStoreFrom(json) {
  const store = new FactStore();
  store.facts = json.facts.map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error(`fact ${i} is not an object`);
    for (const field of ['subject', 'predicate', 'validFrom', 'recordedAt', 'source']) {
      if (!f[field]) throw new Error(`fact ${i} is missing ${field}`);
    }
    const validTo = f.validTo ?? null;
    if (validTo !== null && validTo <= f.validFrom) {
      throw new Error(`fact ${i} has validTo on or before validFrom`);
    }
    return {
      subject: f.subject,
      predicate: f.predicate,
      value: 'value' in f ? f.value : null,
      validFrom: f.validFrom,
      validTo,
      recordedAt: f.recordedAt,
      source: f.source,
      // A payload that never carried a confidence has an unknown one. Defaulting
      // it to 1 would present a guess as certainty; null renders as 'n/a'.
      confidence: typeof f.confidence === 'number' ? f.confidence : null,
    };
  });
  return store;
}

/**
 * Key-order-independent serialisation, used for both the checksum and fact
 * identity. A store that round-trips payloads through its own JSON
 * representation may hand keys back in a different order, and a byte checksum
 * would then condemn a perfectly good snapshot.
 */
function stableStringify(value) {
  // JSON.stringify defers to toJSON(), so a Date lands in the payload as an
  // ISO string. Rendering it here as `{}` instead — Object.keys(date) is empty
  // — hashes something the store never held, and the snapshot is condemned as
  // corrupt on the very next read.
  const v = value !== null && typeof value === 'object' && typeof value.toJSON === 'function'
    ? value.toJSON()
    : value;

  if (v === null) return 'null';
  if (typeof v !== 'object') {
    const out = JSON.stringify(v);
    // undefined, functions and symbols: JSON.stringify renders them as nothing
    // in an object and as null in an array. The object case is handled below by
    // dropping the key; reaching here means the array position.
    return out === undefined ? 'null' : out;
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;

  const parts = [];
  for (const key of Object.keys(v).sort()) {
    const entry = v[key];
    // JSON.stringify DROPS a key whose value is undefined. Emitting "key":null
    // instead is the difference between the hash and the bytes written, and a
    // fact asserted without a `value` — which FactStore.assert permits — was
    // enough to make every save afterwards unreadable while reporting ok.
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * FNV-1a over the body. This detects a truncated, half-written or hand-edited
 * payload; it is not a MAC and proves nothing about who wrote it.
 */
function checksum(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // imul, because `h * prime` overflows into a float and stops distinguishing
    // payloads that differ only in their low bits.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function countsOf(body) {
  return {
    nodes: body.graph.nodes.length,
    edges: body.graph.edges.length,
    facts: body.facts.facts.length,
  };
}

function bySavedAtDesc(a, b) {
  // Unknown save times sort last: they are the migrated and the broken, and
  // neither should displace a snapshot that knows when it was written.
  if (a.savedAt === b.savedAt) return a.id < b.id ? -1 : 1;
  if (a.savedAt === null) return 1;
  if (b.savedAt === null) return -1;
  return a.savedAt < b.savedAt ? 1 : -1;
}

const unwrap = ({ graph, facts }) => ({ graph, facts });
// An unknown save time stays null. Stringifying it gives the literal "null",
// which then reads as a savedAt and sorts as the NEWEST snapshot in the
// listing — the exact inversion bySavedAtDesc exists to prevent.
const iso = (d) => {
  if (d === null || d === undefined) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString();
  return String(d);
};
const isGraph = (g) => Boolean(g) && typeof g.toJSON === 'function' && g.nodes instanceof Map;
const isFactStore = (f) => Boolean(f) && typeof f.toJSON === 'function' && Array.isArray(f.facts);

async function tolerant(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function assertStore(store) {
  for (const method of ['get', 'set', 'list']) {
    if (typeof store?.[method] !== 'function') {
      throw new Error(`a snapshot store needs a ${method}() — see MemoryStore`);
    }
  }
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`invalid snapshot id: ${JSON.stringify(id)}`);
  }
}

export const __internals = { previousKey, quarantineKey, checksum, stableStringify, factIdentity };
