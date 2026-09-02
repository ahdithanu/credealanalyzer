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

const iso = (d) => (d instanceof Date ? d.toISOString() : String(d));

export class FactStore {
  constructor() {
    /** @type {Fact[]} append-only */
    this.facts = [];
  }

  /**
   * Record a fact. Returns the stored fact.
   * `validTo` of null means open-ended.
   */
  assert({ subject, predicate, value, validFrom, validTo = null, recordedAt, source, confidence = 1 }) {
    if (!subject || !predicate) throw new Error('a fact needs a subject and a predicate');
    if (!validFrom) throw new Error(`fact ${subject}.${predicate} needs a validFrom`);
    if (!source) throw new Error(`fact ${subject}.${predicate} needs a source for lineage`);
    if (validTo !== null && iso(validTo) <= iso(validFrom)) {
      throw new Error(`fact ${subject}.${predicate} has validTo on or before validFrom`);
    }
    const fact = {
      subject, predicate, value,
      validFrom: iso(validFrom),
      validTo: validTo === null ? null : iso(validTo),
      recordedAt: iso(recordedAt ?? new Date()),
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
    const v = iso(validAt);
    const k = iso(knownAt);
    let best = null;
    for (const f of this.facts) {
      if (f.subject !== subject || f.predicate !== predicate) continue;
      if (f.validFrom > v) continue;
      if (f.validTo !== null && f.validTo <= v) continue;
      if (f.recordedAt > k) continue;                 // not yet known at that time
      // Latest thing we knew wins. A tie on recordedAt is not rare: canonicalize()
      // stamps one timestamp across a whole ingest batch, so an open-ended fact
      // and a bounded one from the same source tie by construction. The tie
      // breaks on the NARROWER valid window — a fact bounded to a period is a
      // more specific claim about this instant than an open-ended one. Leaving
      // it to array order made the answer depend on the order facts happen to
      // sit in, which a persistence layer then has to preserve for a reason
      // nothing on screen can explain.
      if (!best || f.recordedAt > best.recordedAt) { best = f; continue; }
      if (f.recordedAt === best.recordedAt && validWindowWidth(f) < validWindowWidth(best)) best = f;
    }
    return best;
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
      .filter((f) => f.subject === subject && f.predicate === predicate)
      .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
  }

  /**
   * Facts recorded after `since` that change a previously-known answer for a
   * valid period — i.e. retroactive corrections. Worth surfacing: these are the
   * ones that can move an underwriting after a deal was approved.
   */
  corrections(since) {
    const s = iso(since);
    const out = [];
    for (const f of this.facts) {
      if (f.recordedAt <= s) continue;
      const priorKnown = this.get(f.subject, f.predicate, {
        validAt: f.validFrom,
        knownAt: new Date(Date.parse(f.recordedAt) - 1),
      });
      if (priorKnown && !Object.is(priorKnown.value, f.value)) {
        out.push({ subject: f.subject, predicate: f.predicate, from: priorKnown, to: f });
      }
    }
    return out;
  }

  get size() { return this.facts.length; }


  /** Serialise for persistence. Append-only, so this is the whole truth. */
  toJSON() { return { facts: this.facts }; }

  static fromJSON(json) {
    const s = new FactStore();
    s.facts = (json?.facts ?? []).slice();
    return s;
  }
}

/**
 * Width of a fact's valid window, used only to break a recordedAt tie. An
 * open-ended fact is infinitely wide, and so loses to any bounded one; a window
 * whose ends will not parse is treated the same way rather than compared as
 * text.
 */
function validWindowWidth(f) {
  if (f.validTo === null || f.validTo === undefined) return Infinity;
  const from = Date.parse(f.validFrom);
  const to = Date.parse(f.validTo);
  return Number.isNaN(from) || Number.isNaN(to) ? Infinity : to - from;
}
