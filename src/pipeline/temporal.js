/**
 * Bitemporal fact store.
 *
 * Every fact carries two clocks:
 *
 *   valid time       when the fact was true in the world
 *                    (a 2025 tax roll is valid for calendar 2025)
 *   transaction time when we learned it
 *                    (we ingested that roll on 3 March 2026)
 *
 * One clock is not enough. Assessors issue retroactive corrections; a
 * single-clock store silently rewrites history when one lands, and you can no
 * longer answer "what did the model see when the committee approved this deal?"
 * That question is the audit trail, so both clocks are load-bearing.
 *
 * The store is append-only. A correction is a new fact recorded later over the
 * same valid period; nothing is ever mutated or deleted.
 *
 * Both clocks are compared as INSTANTS, never as text. ISO-8601 does not
 * require zero padding, so '2025-1-1' is a legal date that sorts after
 * '2025-06-01' as a string: a text compare hid such a fact from every query
 * inside its own valid window and returned null — an answer indistinguishable
 * from "we never knew that". Any timestamp that names no instant is refused at
 * the door (`assert`) or quarantined on load (`fromJSON`), so a fact that
 * reaches the query path can always be placed on both clocks.
 */

/** @typedef {Object} Fact
 * @property {string} subject    Entity id the fact is about
 * @property {string} predicate  Attribute name
 * @property {*}      value
 * @property {string} validFrom  ISO date, inclusive
 * @property {string|null} validTo ISO date, exclusive; null = still valid
 * @property {string} recordedAt ISO timestamp we learned it
 * @property {string} source     Source id, for lineage
 * @property {number} confidence 0..1
 */

/** @typedef {Object} Quarantined
 * @property {number} index  Position in the payload it was loaded from
 * @property {string} reason Why it cannot be answered with
 * @property {*}      fact   The row exactly as it arrived
 */

// YYYY-M-D and YYYY-M, zero padding optional — the ISO date-only shapes, and
// the shapes this pipeline's sources actually emit.
const DATE_ONLY = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/;
const PACKED_DATE_MIN = 10000101;   // 1000-01-01 as YYYYMMDD
const PACKED_DATE_MAX = 99991231;   // 9999-12-31 as YYYYMMDD

const iso = (d) => {
  if (d instanceof Date) return d.toISOString();
  // Epoch milliseconds name an instant as precisely as an ISO string does, but
  // String(1767225600000) parses back as nothing at all — storing that would
  // turn `Date.now()`, the most obvious thing a caller passes, into a fact that
  // is refused for being untimestamped.
  if (typeof d === 'number' && Number.isFinite(d)) return new Date(d).toISOString();
  const text = String(d);
  // A date-only string is stored ZERO-PADDED. This store compares instants, but
  // sources.js and project.js still sort and match these same values as TEXT
  // ('2025-06-01'.localeCompare('2025-1-1') < 0, so a June observation sorts
  // before January and the "latest" of a series is the wrong one). Padding here
  // makes the text order agree with the instant order. A value already padded
  // is returned byte-identical, so stored facts and persisted checksums are
  // untouched.
  const m = DATE_ONLY.exec(text);
  if (m) {
    const [, y, mo, day] = m;
    return `${y}-${mo.padStart(2, '0')}-${(day ?? '01').padStart(2, '0')}`;
  }
  return text;
};

export class FactStore {
  constructor() {
    /** @type {Fact[]} append-only */
    this.facts = [];
    /**
     * Rows a load could not place on both clocks. They are held rather than
     * dropped because this is an audit store: see `fromJSON`.
     * @type {Quarantined[]}
     */
    this.quarantined = [];
  }

  /**
   * Record a fact. Returns the stored fact.
   * `validTo` of null means open-ended.
   */
  assert({ subject, predicate, value, validFrom, validTo = null, recordedAt, source, confidence = 1 }) {
    if (!subject || !predicate) throw new Error('a fact needs a subject and a predicate');
    if (!validFrom) throw new Error(`fact ${subject}.${predicate} needs a validFrom`);
    if (!source) throw new Error(`fact ${subject}.${predicate} needs a source for lineage`);

    const recorded = recordedAt ?? new Date();
    // Timestamps are parsed here, at the only door into the store, so that no
    // later comparison has to decide what an unplaceable fact means. Refusing
    // it is louder than storing it: a fact off both clocks answers no question
    // correctly, and one stored silently is found months later by an auditor.
    const from = instantOrThrow(validFrom, `fact ${subject}.${predicate} validFrom`);
    instantOrThrow(recorded, `fact ${subject}.${predicate} recordedAt`);
    if (validTo !== null && validTo !== undefined) {
      const to = instantOrThrow(validTo, `fact ${subject}.${predicate} validTo`);
      if (to <= from) throw new Error(`fact ${subject}.${predicate} has validTo on or before validFrom`);
    }

    const fact = {
      subject, predicate, value,
      validFrom: iso(validFrom),
      validTo: validTo === null || validTo === undefined ? null : iso(validTo),
      recordedAt: iso(recorded),
      source,
      confidence,
    };
    this.facts.push(fact);
    return fact;
  }

  assertMany(facts) {
    return facts.map((f) => this.assert(f));
  }

  /**
   * The value of one predicate as at a point in both clocks.
   *
   * @param {string} subject
   * @param {string} predicate
   * @param {{validAt?:string|Date, knownAt?:string|Date}} at
   *   `validAt` — the moment in the world. Defaults to now.
   *   `knownAt` — what we knew as of this ingestion time. Defaults to now,
   *   i.e. current best knowledge. Pin it to reproduce a past decision.
   * @returns {Fact|null}
   */
  get(subject, predicate, { validAt = new Date(), knownAt = new Date() } = {}) {
    // A query moment that names no instant is a caller bug. Answering it
    // anyway would put a plausible number in front of a committee, and nothing
    // downstream can tell that answer apart from a real one.
    const v = instantOrThrow(validAt, 'validAt');
    const k = instantOrThrow(knownAt, 'knownAt');
    return resolve(this.facts, subject, predicate, v, (recorded) => recorded <= k);
  }

  /** Convenience: the value alone, or `fallback` when unknown. */
  value(subject, predicate, at, fallback = null) {
    const f = this.get(subject, predicate, at);
    return f ? f.value : fallback;
  }

  /** Every predicate for a subject, as at both clocks. */
  snapshot(subject, at = {}) {
    const predicates = new Set(
      this.facts.filter((f) => f.subject === subject).map((f) => f.predicate),
    );
    const out = {};
    for (const p of predicates) {
      const f = this.get(subject, p, at);
      if (f) out[p] = f;
    }
    return out;
  }

  /**
   * Every version of one fact, newest knowledge first. This is the audit view:
   * it shows corrections, who said what, and when we learned it.
   */
  history(subject, predicate) {
    return this.facts
      .map((fact, index) => ({ fact, index, recorded: instant(fact.recordedAt), width: validWidth(fact) }))
      .filter(({ fact }) => fact.subject === subject && fact.predicate === predicate)
      .sort((a, b) => {
        // A row off the transaction clock cannot claim to be the newest
        // knowledge, so it sorts last rather than wherever its text falls.
        if (a.recorded === null || b.recorded === null) {
          if (a.recorded === b.recorded) return a.index - b.index;
          return a.recorded === null ? 1 : -1;
        }
        if (a.recorded !== b.recorded) return b.recorded - a.recorded;
        // Exactly resolve()'s tie-break, in the same order, so history[0] is
        // always the fact get() answers with. Sorting on recordedAt and append
        // order alone left the audit view naming a DIFFERENT fact as current
        // knowledge than the store answers with — the same disagreement the
        // resolver was unified to prevent, just moved to the other reader.
        if (a.width !== b.width) return a.width - b.width;
        return b.index - a.index;
      })
      .map(({ fact }) => fact);
  }

  /**
   * Facts recorded after `since` that change a previously-known answer for a
   * valid period — i.e. retroactive corrections. Worth surfacing: these are the
   * ones that can move an underwriting after a deal was approved.
   *
   * "Changes the answer" is checked against the store, not against a window of
   * time before the fact arrived. Looking back at `recordedAt - 1ms` missed
   * every same-batch supersession, and canonicalize() stamps ONE timestamp
   * across an entire ingest batch — so a correction landing beside the fact it
   * supersedes was invisible by construction, which is the common case rather
   * than an exotic one.
   */
  corrections(since) {
    const s = instantOrThrow(since, 'corrections() `since`');
    const out = [];
    for (let i = 0; i < this.facts.length; i++) {
      const f = this.facts[i];
      const recorded = instant(f.recordedAt);
      const validAt = instant(f.validFrom);
      if (recorded === null || validAt === null) continue;
      if (recorded <= s) continue;

      // A fact only corrects something if the store actually answers with it
      // once it is known. Without this, a broad fact appended beside a narrower
      // one in the same batch reported a correction that never took effect.
      const answer = resolve(this.facts, f.subject, f.predicate, validAt, (r) => r <= recorded);
      if (answer !== f) continue;

      const prior = resolve(
        this.facts, f.subject, f.predicate, validAt,
        (r, j) => r < recorded || (r === recorded && j < i),
      );
      if (prior && !Object.is(prior.value, f.value)) {
        out.push({ subject: f.subject, predicate: f.predicate, from: prior, to: f });
      }
    }
    return out;
  }

  /** Facts that can answer a query. Quarantined rows are deliberately not counted. */
  get size() { return this.facts.length; }

  /**
   * Serialise for persistence. Append-only, so this is the whole truth —
   * including anything quarantined, which is emitted only when it exists so a
   * clean store serialises byte-identically to how it always has.
   */
  toJSON() {
    const out = { facts: this.facts };
    if (this.quarantined.length) out.quarantined = this.quarantined;
    return out;
  }

  /**
   * Rebuild a store from a payload, validating every row.
   *
   * Assigning the array wholesale was the dangerous shape. A fact with no
   * `recordedAt` was not invisible — it was PERMANENT: every comparison against
   * undefined is false, so it slipped past the knownAt filter and was always
   * returned, and no later correction could ever outrank it. A fact that cannot
   * be corrected is the worst failure available to an append-only audit store.
   *
   * A malformed row is QUARANTINED, not repaired and not silently dropped.
   * Repairing it (stamping "now" over a missing recordedAt, say) fabricates a
   * transaction time, which is the one field the audit trail rests on. Dropping
   * it changes a bitemporal answer with nothing on screen to say so. Rejecting
   * the whole payload loses an entire history to one bad row. So the row is set
   * aside, kept verbatim with a reason, carried through `toJSON`, and left
   * where the caller can see it in `store.quarantined`.
   */
  static fromJSON(json) {
    // `{}` or undefined would otherwise yield an empty store, and "we know
    // nothing" is indistinguishable from "nothing has ever been recorded".
    if (!json || typeof json !== 'object' || !Array.isArray(json.facts)) {
      throw new Error('FactStore.fromJSON needs a payload with a facts array');
    }
    if (json.quarantined !== undefined && !Array.isArray(json.quarantined)) {
      throw new Error('FactStore.fromJSON payload has a quarantined field that is not an array');
    }

    const s = new FactStore();
    json.facts.forEach((f, index) => {
      const reason = unloadable(f);
      if (reason) { s.quarantined.push({ index, reason, fact: f }); return; }
      s.facts.push({
        subject: f.subject,
        predicate: f.predicate,
        // A payload that never carried a value has an unknown one, and
        // `undefined` is dropped by JSON.stringify — null survives a round trip
        // and renders as 'n/a'.
        value: 'value' in f ? f.value : null,
        validFrom: iso(f.validFrom),
        validTo: f.validTo === null || f.validTo === undefined ? null : iso(f.validTo),
        recordedAt: iso(f.recordedAt),
        source: f.source,
        // Defaulting a missing confidence to 1 would present a guess as
        // certainty; null renders as 'n/a'.
        confidence: typeof f.confidence === 'number' ? f.confidence : null,
      });
    });

    for (const q of json.quarantined ?? []) {
      s.quarantined.push(
        q && typeof q === 'object' && 'fact' in q
          ? { index: typeof q.index === 'number' ? q.index : null, reason: q.reason ?? 'quarantined by an earlier load, reason not recorded', fact: q.fact }
          : { index: null, reason: 'quarantine record was itself unreadable', fact: q },
      );
    }
    return s;
  }
}

/**
 * Milliseconds since epoch, or null when the value names no instant. Null is
 * the whole point: every caller then has to decide what an unplaceable
 * timestamp means, instead of a string compare quietly deciding for them.
 */
function instant(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Epoch milliseconds, so that Date.now() works. But a YYYYMMDD integer date
    // column is also a finite number, and read as epoch ms it dates the fact to
    // 1970-01-01 — confidently wrong, where the identical value as a string is
    // correctly refused. Nothing this store holds is dated inside the first two
    // days of the epoch, which is exactly the range every packed calendar date
    // lands in, so that range is refused rather than reinterpreted.
    if (Number.isInteger(value) && value >= PACKED_DATE_MIN && value <= PACKED_DATE_MAX) return null;
    return value;
  }
  const text = String(value);
  // ES2015+ places a PADDED ISO date-only string on UTC, but sends anything the
  // ISO grammar rejects — '2025-1-1', the module header's own motivating
  // example — to the implementation parser, which places it on the LOCAL clock.
  // Jest runs in UTC so no test can see the split; the app is a browser SPA
  // running in the user's zone, where it opened a five-hour hole between a fact
  // ending at 00:00Z and its successor starting at 05:00Z, and answered a
  // superseded tax rate on the other side of the date line. Date-only forms are
  // therefore placed on UTC here, padded or not.
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return Date.UTC(Number(y), Number(m) - 1, d === undefined ? 1 : Number(d));
  }
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t;
}


function instantOrThrow(value, what) {
  const t = instant(value);
  if (t === null) throw new Error(`${what} is not a timestamp that names an instant: ${JSON.stringify(value ?? null)}`);
  return t;
}

/**
 * How wide a fact's valid window is; Infinity for open-ended. The tie-break key
 * resolve() and history() share, so a bounded claim outranks a standing one at
 * the same instant in both.
 */
function validWidth(f) {
  const from = instant(f.validFrom);
  if (from === null) return Infinity;
  if (f.validTo === null || f.validTo === undefined) return Infinity;
  const to = instant(f.validTo);
  return to === null ? Infinity : to - from;
}

/** Why a payload row cannot be answered with, or null if it can. */
function unloadable(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'not an object';
  for (const field of ['subject', 'predicate', 'source']) {
    if (!f[field]) return `missing ${field}`;
  }
  if (f.validFrom === null || f.validFrom === undefined) return 'missing validFrom';
  const from = instant(f.validFrom);
  if (from === null) return 'validFrom is not a timestamp that names an instant';
  if (f.recordedAt === null || f.recordedAt === undefined) return 'missing recordedAt';
  const recorded = instant(f.recordedAt);
  if (recorded === null) return 'recordedAt is not a timestamp that names an instant';
  if (f.validTo !== null && f.validTo !== undefined) {
    const to = instant(f.validTo);
    if (to === null) return 'validTo is not a timestamp that names an instant';
    if (to <= from) return 'validTo on or before validFrom';
  }
  return null;
}

/**
 * The fact answering (subject, predicate) at `validInstant`, among those whose
 * recorded instant and append position `admits` accepts. Shared by `get` and
 * `corrections` so the two can never disagree about which fact the store
 * answers with — that disagreement is what let a correction go unreported.
 */
function resolve(facts, subject, predicate, validInstant, admits) {
  let best = null;
  let bestRecorded = null;
  let bestWidth = null;
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    if (f.subject !== subject || f.predicate !== predicate) continue;

    const from = instant(f.validFrom);
    const recorded = instant(f.recordedAt);
    // Neither clock places this row, so it answers nothing. `assert` and
    // `fromJSON` both refuse such rows; reaching here means the array was
    // assigned past them, and answering with it would be worse than a gap.
    if (from === null || recorded === null) continue;
    if (from > validInstant) continue;

    let to = null;
    if (f.validTo !== null && f.validTo !== undefined) {
      to = instant(f.validTo);
      if (to === null) continue;
      if (to <= validInstant) continue;
    }
    if (!admits(recorded, i)) continue;

    const width = to === null ? Infinity : to - from;
    if (best === null || recorded > bestRecorded) { best = f; bestRecorded = recorded; bestWidth = width; continue; }
    if (recorded < bestRecorded) continue;
    // Latest thing we knew wins. A tie on recordedAt is not rare: canonicalize()
    // stamps one timestamp across a whole ingest batch, so an open-ended fact
    // and a bounded one from the same source tie by construction. The tie
    // breaks on the NARROWER valid window — a fact bounded to a period is a
    // more specific claim about this instant than an open-ended one. Leaving
    // it to array order made the answer depend on the order facts happen to
    // sit in, which a persistence layer then has to preserve for a reason
    // nothing on screen can explain.
    if (width < bestWidth) { best = f; bestRecorded = recorded; bestWidth = width; continue; }
    // Same instant, same window: two claims about exactly the same thing, and
    // the append log is the only record of which came second. Preferring the
    // first would make a correction issued in its own batch unable to land —
    // an uncorrectable fact — which is the failure this store exists to avoid.
    if (width === bestWidth) { best = f; bestRecorded = recorded; bestWidth = width; }
  }
  return best;
}
