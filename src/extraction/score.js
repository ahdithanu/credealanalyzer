/**
 * Scoring an extractor against hand-labelled ground truth.
 *
 * The design rule here is the one this repository keeps re-learning: a control
 * that reports success without observing anything is worse than no control at
 * all. Two consequences shape this file.
 *
 * 1. CITATIONS ARE VERIFIED, NOT BELIEVED. An extractor that returns
 *    `quality: 'sourced'` is making a checkable claim: that the value appears
 *    at the span it names. We go and read that span. A citation that does not
 *    contain the value is counted as UNGROUNDED even when the value is
 *    correct, because a right answer with a fabricated citation is a system
 *    that will be wrong later and still look sourced. This is the same move as
 *    reading `pg_roles` back after `ALTER ROLE` instead of assuming it took.
 *
 * 2. THERE IS NO SINGLE HEADLINE NUMBER, and `score()` deliberately does not
 *    produce one. An extractor that abstains on every field has a perfect
 *    hallucination rate. An extractor that guesses every field has perfect
 *    coverage. Either collapses to a flattering scalar, which is how an eval
 *    stops measuring the thing it was built for. Callers get the pair and have
 *    to look at both.
 */

import {
  FIELDS, FIELD_NAMES, fieldByName, valuesAgree, classifyPropertyType,
} from './schema.js';

/**
 * Per-field outcomes. The names are chosen so that a report reads as English
 * and so that the two failure modes can never be confused for each other:
 * `miss` is timidity, `hallucination` is invention, and a system is usually
 * bad at exactly one of them.
 */
export const OUTCOME = {
  HIT: 'hit',                               // in the document, answered, correct
  ERROR: 'error',                           // in the document, answered, wrong
  MISS: 'miss',                             // in the document, abstained
  HALLUCINATION: 'hallucination',           // NOT in the document, answered anyway
  CORRECT_ABSTENTION: 'correct_abstention', // NOT in the document, abstained
};

/**
 * An extractor's answer for one field, or the absence of one.
 *
 * `quality` mirrors the vocabulary already used by the market pipeline in
 * src/pipeline/project.js, so that a deal assembled partly from a document and
 * partly from market data carries one provenance model rather than two:
 *
 *   'sourced'  — stated in the document, and `citation` says where
 *   'estimate' — derived or inferred, not stated (cap rate computed from NOI
 *                and price, say); a citation is not required and not expected
 *
 * Abstention is the ABSENCE of a key, or an explicit null value. Those are
 * treated identically on purpose: a pipeline that drops undefined keys on
 * serialisation must not thereby change its score.
 */

/** @returns {boolean} true when the extractor declined to answer this field. */
export function abstained(answer) {
  return answer === undefined || answer === null
    || answer.value === undefined || answer.value === null;
}

/**
 * Does the cited span actually contain the value it is cited for?
 *
 * This is intentionally a dumb, literal check against the document text. It
 * can be fooled, and it is not trying to be a semantic judge — it is trying to
 * catch the failure that actually happens, which is a citation pointing at a
 * page that never mentioned the number. A dumb check that runs on every field
 * beats a clever one nobody can trust the output of.
 *
 * Numbers are matched on their digits with separators stripped, so that a
 * document reading "$12,400,000" grounds a value of 12400000, and one reading
 * "6.25%" grounds 6.25.
 *
 * @param {{page:number, start:number, end:number}} citation
 * @param {*} value
 * @param {(page:number) => string} pageText  reader over the source document
 * @param {string} [fieldName]  when the field is an enum, the span is judged by
 *   what it states, through the same mapping the labels use: a filing says
 *   "Office / Retail", never "mixed-use", and a literal check would call every
 *   correctly cited type ungrounded.
 */
export function citationSupports(citation, value, pageText, fieldName) {
  if (!citation || typeof pageText !== 'function') return false;
  const { page, start, end } = citation;
  if (!Number.isInteger(page) || !Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (end <= start) return false;

  let text;
  try {
    text = pageText(page);
  } catch {
    return false;
  }
  if (typeof text !== 'string') return false;

  // A span running past the end of the page is itself a fabrication signal:
  // the model invented coordinates. Refuse rather than silently clamping.
  if (start < 0 || end > text.length) return false;

  const span = text.slice(start, end);
  if (fieldName && fieldByName(fieldName).kind === 'enum') {
    return typeof value === 'string' && classifyPropertyType(span) === value.trim().toLowerCase();
  }
  if (typeof value === 'number') {
    const digits = String(value).replace(/[^0-9]/g, '');
    const spanDigits = span.replace(/[^0-9]/g, '');
    return digits.length > 0 && spanDigits.includes(digits);
  }
  return span.toLowerCase().includes(String(value).trim().toLowerCase());
}

/**
 * Score one document.
 *
 * @param {Object} opts
 * @param {Object} opts.predicted  field -> {value, quality, citation?, confidence?}
 * @param {Object} opts.truth      field -> value, or null meaning NOT IN DOCUMENT
 * @param {(page:number)=>string} [opts.pageText]  when given, citations are verified
 * @returns {{byField:Object, counts:Object, ungrounded:string[]}}
 */
export function scoreDocument({ predicted = {}, truth = {}, pageText } = {}) {
  const byField = {};
  const counts = Object.fromEntries(Object.values(OUTCOME).map((o) => [o, 0]));
  const ungrounded = [];

  for (const name of FIELD_NAMES) {
    fieldByName(name); // throws on an unscoreable field rather than skipping it

    const inDocument = Object.prototype.hasOwnProperty.call(truth, name)
      && truth[name] !== null && truth[name] !== undefined;
    const answer = predicted[name];
    const declined = abstained(answer);

    let outcome;
    if (!inDocument) {
      outcome = declined ? OUTCOME.CORRECT_ABSTENTION : OUTCOME.HALLUCINATION;
    } else if (declined) {
      outcome = OUTCOME.MISS;
    } else {
      outcome = valuesAgree(name, answer.value, truth[name]) ? OUTCOME.HIT : OUTCOME.ERROR;
    }

    // Groundedness is judged independently of correctness. A claim to be
    // sourced is a separate assertion from the value, and it fails separately.
    let grounded = null;
    if (!declined && answer.quality === 'sourced') {
      grounded = pageText ? citationSupports(answer.citation, answer.value, pageText, name) : null;
      if (grounded === false) ungrounded.push(name);
    }

    counts[outcome]++;
    byField[name] = {
      outcome,
      grounded,
      confidence: declined ? null : numberOrNull(answer.confidence),
      predicted: declined ? null : answer.value,
      truth: inDocument ? truth[name] : null,
    };
  }

  return { byField, counts, ungrounded };
}

/**
 * Aggregate across documents.
 *
 * Every rate below has an explicit denominator in its name's definition,
 * because the interesting mistakes in eval reporting are all denominator
 * mistakes — dividing hallucinations by all fields rather than by the fields
 * that were absent makes a system look better the more complete its documents
 * are, which is backwards.
 */
export function scoreCorpus(documentScores) {
  const counts = Object.fromEntries(Object.values(OUTCOME).map((o) => [o, 0]));
  let groundedTrue = 0;
  let groundedChecked = 0;
  const confidences = [];

  for (const doc of documentScores) {
    for (const o of Object.values(OUTCOME)) counts[o] += doc.counts[o] || 0;
    for (const [, cell] of Object.entries(doc.byField)) {
      if (cell.grounded !== null) {
        groundedChecked++;
        if (cell.grounded) groundedTrue++;
      }
      if (cell.confidence !== null && cell.outcome !== OUTCOME.MISS
          && cell.outcome !== OUTCOME.CORRECT_ABSTENTION) {
        confidences.push({
          confidence: cell.confidence,
          correct: cell.outcome === OUTCOME.HIT,
        });
      }
    }
  }

  const answeredInDoc = counts[OUTCOME.HIT] + counts[OUTCOME.ERROR];
  const inDocument = answeredInDoc + counts[OUTCOME.MISS];
  const absent = counts[OUTCOME.HALLUCINATION] + counts[OUTCOME.CORRECT_ABSTENTION];

  return {
    counts,

    // Of the fields it chose to answer, how often was it right?
    answerAccuracy: ratio(counts[OUTCOME.HIT], answeredInDoc),

    // Of the fields the document actually contained, how many did it attempt?
    // Read this next to answerAccuracy, never instead of it.
    coverage: ratio(answeredInDoc, inDocument),

    // Of the fields the document did NOT contain, how often did it invent one?
    // This is the number an enterprise buyer asks about first.
    hallucinationRate: ratio(counts[OUTCOME.HALLUCINATION], absent),

    // Of the answers claiming to be sourced, how many had a citation that
    // actually held the value? null when no document text was supplied, so
    // that "not checked" never reads as 1.0.
    groundedness: groundedChecked === 0 ? null : groundedTrue / groundedChecked,
    groundedChecked,

    calibration: calibration(confidences),
  };
}

/**
 * Expected calibration error, plus the buckets it came from.
 *
 * Reported with the buckets rather than alone because a single ECE hides
 * direction: a model that is uniformly underconfident and one that is wildly
 * overconfident on its top bucket can share a number, and only the second is
 * dangerous in a product that routes high-confidence answers past review.
 */
export function calibration(samples, bucketCount = 5) {
  if (!samples.length) return { ece: null, buckets: [] };

  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    lo: i / bucketCount,
    hi: (i + 1) / bucketCount,
    n: 0,
    correct: 0,
    meanConfidence: 0,
  }));

  for (const s of samples) {
    const c = Math.min(Math.max(s.confidence, 0), 1);
    const idx = Math.min(bucketCount - 1, Math.floor(c * bucketCount));
    const b = buckets[idx];
    b.meanConfidence = (b.meanConfidence * b.n + c) / (b.n + 1);
    b.n++;
    if (s.correct) b.correct++;
  }

  let ece = 0;
  for (const b of buckets) {
    if (!b.n) continue;
    b.accuracy = b.correct / b.n;
    ece += (b.n / samples.length) * Math.abs(b.meanConfidence - b.accuracy);
  }

  return { ece, buckets: buckets.filter((b) => b.n > 0) };
}

const ratio = (num, den) => (den === 0 ? null : num / den);
const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Two reference points every run should be read against.
 *
 * `abstainAlways` scores a perfect 0 hallucination rate and 0 coverage.
 * `guessAlways` scores perfect coverage and a terrible hallucination rate.
 * A real extractor that does not beat BOTH on their respective weak axis has
 * not demonstrated anything, and these exist so that claim can be checked
 * rather than asserted.
 */
export const BASELINES = {
  abstainAlways: () => ({}),
  guessAlways: (filler) => Object.fromEntries(
    FIELDS.map((f) => [f.name, { value: filler[f.name], quality: 'estimate', confidence: 0.5 }]),
  ),
};
