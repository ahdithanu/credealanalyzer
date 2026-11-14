/**
 * Human review of extracted fields (contract C4), as pure functions.
 *
 * An extraction is a claim about a document. It becomes an underwriting input
 * only after a person has looked at it and said so. This file is the whole of
 * that rule, kept out of the screen so it can be tested without one:
 *
 *   pending    the extractor said this; nobody has looked yet
 *   confirmed  a reviewer accepted the extracted value as it stands
 *   rejected   a reviewer said the extracted value is wrong; it goes nowhere
 *   edited     a reviewer entered the value themselves (correcting the
 *              extractor, or filling a field the extractor abstained on)
 *
 * Only 'confirmed' and 'edited' values ever leave through appliedValues().
 * Nothing here changes a status on its own: every transition is a function a
 * human action calls.
 *
 * Entry shape: { status, value, note?, original, origin }.
 *   `original` is the extracted value (null for a manual entry), kept so an
 *   edit never destroys what the extractor said and a reset can restore it.
 *   `origin` is 'extracted' or 'manual'. A manual entry has no citation: the
 *   extractor abstained, so there is no quote to show for it.
 *
 * Every function returns a new review object; none mutates its input.
 */

export const STATUSES = ['pending', 'confirmed', 'rejected', 'edited'];
const APPLIED = new Set(['confirmed', 'edited']);

function fieldNames(fields) {
  return new Set((fields || []).map((f) => f.name));
}

/**
 * Every predicted field starts 'pending'. Fields the extractor abstained on
 * are NOT given an entry: an abstention is "not stated in the document", and
 * inventing a pending null for it would let a confirm click turn an absence
 * into an applied value.
 *
 * A prediction for a field the schema does not define is an error rather than
 * something to drop, because dropping it would hide an answer from review.
 */
export function initialReview(predictions = {}, fields = null) {
  const known = fields ? fieldNames(fields) : null;
  const review = {};
  for (const [name, p] of Object.entries(predictions || {})) {
    if (known && !known.has(name)) {
      throw new Error(`prediction for unknown field ${JSON.stringify(name)}`);
    }
    if (!p || p.value === null || p.value === undefined) continue;
    review[name] = { status: 'pending', value: p.value, original: p.value, origin: 'extracted' };
  }
  return review;
}

function requireEntry(review, name, verb) {
  const e = review?.[name];
  if (!e) throw new Error(`cannot ${verb} ${JSON.stringify(name)}: nothing was extracted for it`);
  return e;
}

function withNote(entry, note) {
  const next = { ...entry };
  if (typeof note === 'string' && note.trim()) next.note = note.trim();
  else delete next.note;
  return next;
}

/** Accept the EXTRACTED value as it stands. A manual entry cannot be "confirmed": it is already the reviewer's own value. */
export function confirm(review, name, note) {
  const e = requireEntry(review, name, 'confirm');
  if (e.origin === 'manual') throw new Error(`cannot confirm ${JSON.stringify(name)}: it was entered manually`);
  return { ...review, [name]: withNote({ ...e, status: 'confirmed', value: e.original }, note) };
}

/** Say the extracted value is wrong. It is kept on the entry for the record but never applied. */
export function reject(review, name, note) {
  const e = requireEntry(review, name, 'reject');
  if (e.origin === 'manual') throw new Error(`cannot reject ${JSON.stringify(name)}: it was entered manually; reset it instead`);
  return { ...review, [name]: withNote({ ...e, status: 'rejected', value: e.original }, note) };
}

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
    || (typeof v === 'number' && !Number.isFinite(v));
}

/**
 * Enter a value by hand. Requires a value: an edit to nothing is not a
 * correction, and it would apply a null as if a person had stated it.
 * On a field the extractor abstained on, this creates a manual entry.
 */
export function edit(review, name, value, note) {
  if (isBlank(value)) throw new Error(`edit of ${JSON.stringify(name)} needs a value`);
  const e = review?.[name];
  const base = e
    ? { ...e }
    : { original: null, origin: 'manual' };
  return { ...review, [name]: withNote({ ...base, status: 'edited', value }, note) };
}

/** Undo a decision: an extracted field returns to pending with its original value; a manual entry is removed. */
export function reset(review, name) {
  const e = requireEntry(review, name, 'reset');
  const next = { ...review };
  if (e.origin === 'manual') delete next[name];
  else next[name] = { status: 'pending', value: e.original, original: e.original, origin: 'extracted' };
  return next;
}

/** The values a human has accepted or entered. The ONLY way out to deal inputs. */
export function appliedValues(review = {}) {
  const out = {};
  for (const [name, e] of Object.entries(review || {})) {
    if (e && APPLIED.has(e.status) && !isBlank(e.value)) out[name] = e.value;
  }
  return out;
}

/** Counts per status, for the screen's summary line. */
export function reviewSummary(review = {}) {
  const out = { pending: 0, confirmed: 0, rejected: 0, edited: 0 };
  for (const e of Object.values(review || {})) if (out[e.status] !== undefined) out[e.status] += 1;
  return out;
}

const NUMERIC_KINDS = new Set(['money', 'percent', 'area', 'year']);

/**
 * Turn what a reviewer typed into a typed value for `field`, or an error.
 * Separators and a leading $ are tolerated for numbers ("12,400,000",
 * "$12.4"); anything else unreadable is refused rather than coerced, so a typo
 * can never become a zero.
 *
 * @returns {{value:*}|{error:string}}
 */
export function parseEdit(field, raw) {
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (isBlank(s)) return { error: 'Enter a value.' };
  if (NUMERIC_KINDS.has(field.kind)) {
    const cleaned = String(s).replace(/[$,%\s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { error: 'Not a number.' };
    const n = Number(cleaned);
    if (field.kind === 'year' && !Number.isInteger(n)) return { error: 'A year is a whole number.' };
    return { value: n };
  }
  if (field.kind === 'enum') {
    const v = String(s).toLowerCase();
    if (Array.isArray(field.options) && !field.options.includes(v)) {
      return { error: `One of: ${field.options.join(', ')}.` };
    }
    return { value: v };
  }
  return { value: String(s) };
}
