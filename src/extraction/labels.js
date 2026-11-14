/**
 * Ground truth for filings that describe many properties.
 *
 * The schema in ./schema.js describes one deal; a 10-K describes dozens. So a
 * filing's labels are a list of SUBJECTS — properties drawn from the filing's
 * per-property table by ./sample.js — each with a full ground-truth record.
 * The eval unit is (filing, subject).
 *
 * Three guards live here, each closing a way a corpus can look labelled
 * without being labelled:
 *
 *   assertDrawn           the labelled subjects are exactly the draw, in draw
 *                         order — nobody swapped in the properties that were
 *                         easy to label or that the extractor happened to get
 *   assertCompleteLabels  every field is labelled explicitly. A missing key
 *                         reads to the scorer as "not in the document", which
 *                         is the unlabelled-versus-absent confusion again, one
 *                         field at a time
 *   verifyEvidence        every stated value carries the verbatim text it was
 *                         read from, and that text is in the document and
 *                         holds the value. A label nobody can check is a
 *                         claim, not ground truth
 */

import {
  FIELDS, FIELD_NAMES, fieldByName, classifyPropertyType, spanHoldsNumber,
} from './schema.js';
import { sampleSubjects } from './sample.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The labelled subjects must be a prefix of the draw, in order. */
export function assertDrawn(entry) {
  const s = entry.subjects;
  if (!s || !Array.isArray(s.items) || !Array.isArray(s.population)) {
    throw new Error(`${entry.id}: no subjects to check`);
  }
  const labelled = s.items.map((i) => i.subject);
  const drawn = sampleSubjects(entry.id, s.population, labelled.length);
  labelled.forEach((subject, i) => {
    if (subject !== drawn[i]) {
      throw new Error(
        `${entry.id}: item ${i} is "${subject}" but the draw puts "${drawn[i]}" there. `
        + 'Subjects are drawn, not chosen; see src/extraction/sample.js.',
      );
    }
  });
  return entry;
}

/** @returns {string[]} problems with one subject's ground truth; empty when sound */
export function labelProblems(truth) {
  const problems = [];
  if (!truth || typeof truth !== 'object' || Array.isArray(truth)) return ['groundTruth is not an object'];

  for (const name of FIELD_NAMES) {
    if (!has(truth, name)) problems.push(`${name}: not labelled (use null for "not in the document")`);
  }
  for (const key of Object.keys(truth)) {
    if (!FIELD_NAMES.includes(key)) problems.push(`${key}: not a schema field`);
  }

  for (const f of FIELDS) {
    const v = truth[f.name];
    if (v === null || v === undefined) continue;
    const bad = (why) => problems.push(`${f.name}: ${JSON.stringify(v)} ${why}`);
    switch (f.kind) {
      case 'money':
      case 'area':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad('is not a non-negative number');
        break;
      case 'percent':
        if (typeof v !== 'number' || !Number.isFinite(v)) bad('is not a number');
        // Points, not fractions. 0.94 for 94% is the bug this exists to stop;
        // a genuine sub-one-percent figure is rare enough to justify a note
        // and a rule change rather than a silent pass.
        else if (v > 0 && v < 1) bad('looks like a fraction; percentages are labelled in points');
        else if (v < 0 || v > 100) bad('is outside 0-100');
        break;
      case 'year':
        if (!Number.isInteger(v) || v < 1600 || v > 2100) bad('is not a plausible year');
        break;
      case 'text':
        if (typeof v !== 'string' || !v.trim()) bad('is not a non-empty string');
        break;
      case 'enum':
        if (!f.options.includes(v)) bad(`is not one of ${f.options.join(', ')}`);
        break;
      default:
        bad(`has unscoreable kind ${f.kind}`);
    }
  }
  return problems;
}

export function assertCompleteLabels(entry) {
  const problems = [];
  for (const item of entry.subjects?.items || []) {
    for (const p of labelProblems(item.groundTruth)) problems.push(`${entry.id} / ${item.subject}: ${p}`);
  }
  if (problems.length) throw new Error(`incomplete or malformed labels:\n  ${problems.join('\n  ')}`);
  return entry;
}

/**
 * Does `evidence` — verbatim text from the document — hold `value`?
 * The same literal check the scorer applies to an extractor's citation, so a
 * label is held to exactly the standard an extraction is.
 */
export function evidenceHolds(fieldName, evidence, value) {
  if (typeof evidence !== 'string' || !evidence) return false;
  const { kind } = fieldByName(fieldName);
  if (kind === 'enum') return classifyPropertyType(evidence) === value;
  if (typeof value === 'number') return spanHoldsNumber(evidence, value);
  return evidence.toLowerCase().includes(String(value).trim().toLowerCase());
}

/** @returns {string[]} problems; empty when every stated value is evidenced in `text` */
export function evidenceProblems(text, item) {
  const problems = [];
  const truth = item.groundTruth || {};
  const evidence = item.evidence || {};
  for (const name of FIELD_NAMES) {
    const v = truth[name];
    if (v === null || v === undefined) continue;
    // Evidence is one verbatim fragment, or several when the statement is
    // split across the document: a type code in the row ("| SF |") and its
    // legend ("SF=Specialized Facility"). Every fragment must be in the
    // document; the value is judged against them together.
    const ev = evidence[name];
    const parts = Array.isArray(ev) ? ev : [ev];
    if (!parts.length || parts.some((x) => typeof x !== 'string' || !x)) {
      problems.push(`${name}: stated as ${JSON.stringify(v)} with no evidence`);
    } else if (parts.some((x) => !text.includes(x))) {
      const missing = parts.find((x) => !text.includes(x));
      problems.push(`${name}: evidence ${JSON.stringify(missing)} is not in the document`);
    } else if (!evidenceHolds(name, parts.join(' | '), v)) {
      problems.push(`${name}: evidence ${JSON.stringify(ev)} does not hold ${JSON.stringify(v)}`);
    }
  }
  return problems;
}

export function verifyEvidence(text, entry) {
  const problems = [];
  for (const item of entry.subjects?.items || []) {
    for (const p of evidenceProblems(text, item)) problems.push(`${entry.id} / ${item.subject}: ${p}`);
  }
  if (problems.length) throw new Error(`labels not supported by the document:\n  ${problems.join('\n  ')}`);
  return entry;
}

/**
 * Flatten a manifest into scoreable items.
 * @param {string} [set]  'dev' or 'holdout'; omitted, every item
 */
export function corpusItems(manifest, { set } = {}) {
  const out = [];
  for (const entry of manifest) {
    for (const item of entry.subjects?.items || []) {
      if (set && item.set !== set) continue;
      out.push({
        id: `${entry.id}#${item.subject}`,
        entryId: entry.id,
        localPath: entry.localPath,
        subject: item.subject,
        set: item.set,
        truth: item.groundTruth,
        // A labelling decision that could reasonably go the other way, scored
        // both ways so the number does not hide the choice.
        alternateTruth: item.alternateTruth || null,
      });
    }
  }
  return out;
}
