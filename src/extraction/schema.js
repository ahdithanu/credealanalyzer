/**
 * The extraction target, and how two values of each field are judged equal.
 *
 * This file exists so that "the model got it right" is a decidable question
 * rather than a human impression. Every field declares a `kind`, and every
 * kind declares a comparator with an explicit tolerance. A field with no
 * comparator cannot be scored, so adding a field without one is a type error
 * at score time rather than a silently-skipped column in the report.
 *
 * The tolerances are deliberately not all zero. A cap rate transcribed as
 * 6.25% when the document says 6.3% is a real disagreement; a purchase price
 * of 12,400,000 against 12.4MM is the same number written twice. Scoring both
 * as "wrong" would bury the first kind of error inside the second.
 */

/**
 * `null` in a ground-truth record is load-bearing and means something specific:
 * THE DOCUMENT DOES NOT STATE THIS FIELD. It does not mean "unknown to the
 * labeller" and it does not mean zero.
 *
 * That distinction is the whole reason this harness can measure hallucination.
 * Without it you can only ask "was the answer right", which a system that
 * invents a plausible number for every missing field can still score well on,
 * because the fields it invents are the ones nobody checks.
 */
export const NOT_IN_DOCUMENT = null;

/** @typedef {'money'|'percent'|'area'|'year'|'text'|'enum'} FieldKind */

/**
 * One row per field the extractor is asked for.
 *
 * `required: false` marks a field that is genuinely optional in the source
 * genre — absent from plenty of real documents. Those fields carry most of the
 * abstention signal, because they are where a system under pressure to fill
 * the form will start making things up.
 */
export const FIELDS = [
  { name: 'address',          kind: 'text',    required: true },
  { name: 'propertyType',     kind: 'enum',    required: true,
    options: ['office', 'retail', 'industrial', 'multifamily', 'mixed-use', 'other'] },
  { name: 'squareFeet',       kind: 'area',    required: true },
  { name: 'yearBuilt',        kind: 'year',    required: false },
  { name: 'purchasePrice',    kind: 'money',   required: false },
  { name: 'netOperatingIncome', kind: 'money', required: false },
  { name: 'capRate',          kind: 'percent', required: false },
  { name: 'occupancy',        kind: 'percent', required: false },
];

export const FIELD_NAMES = FIELDS.map((f) => f.name);

/**
 * Comparators, one per kind.
 *
 * Each returns true when the two values should count as the same answer. They
 * take (predicted, truth) in that order and must not be symmetric-by-accident:
 * the tolerance is expressed relative to TRUTH, so that a prediction of 0
 * against a truth of 1,000,000 is not quietly inside a relative band computed
 * from the prediction.
 */
export const COMPARATORS = {
  // Half a percent of the truth. Covers unit-of-expression differences
  // ($12.4MM vs 12,400,000) without covering a transposed digit.
  money: (pred, truth) => isNum(pred) && isNum(truth)
    && Math.abs(pred - truth) <= Math.abs(truth) * 0.005,

  // Percentage POINTS, not relative. A cap rate is quoted to the basis point,
  // and a relative tolerance would make the band at 3% a third of the band at
  // 9% for no reason the domain supports.
  //
  // Values are normalised to points (6.25 means 6.25%), so a predictor that
  // emits 0.0625 is wrong — deliberately. Silently accepting both conventions
  // is how a fraction/percent mix-up reaches production.
  percent: (pred, truth) => isNum(pred) && isNum(truth)
    && Math.abs(pred - truth) <= 0.1,

  // Rounding to the nearest hundred square feet is normal in marketing copy.
  area: (pred, truth) => isNum(pred) && isNum(truth)
    && Math.abs(pred - truth) <= Math.max(50, Math.abs(truth) * 0.002),

  // No tolerance. A building is built in a year or it is not.
  year: (pred, truth) => Number.isInteger(pred) && Number.isInteger(truth) && pred === truth,

  // Whitespace, case and trailing punctuation only. Street abbreviations are
  // NOT normalised ("St" vs "Street"): that is a judgement call that belongs
  // in the labelling guide, where a human makes it once and writes it down,
  // not buried in a comparator where it silently widens every address match.
  text: (pred, truth) => typeof pred === 'string' && typeof truth === 'string'
    && normaliseText(pred) === normaliseText(truth),

  enum: (pred, truth) => typeof pred === 'string' && typeof truth === 'string'
    && pred.trim().toLowerCase() === truth.trim().toLowerCase(),
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function normaliseText(s) {
  return String(s).toLowerCase().replace(/[\s,.]+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

/**
 * How a property type the DOCUMENT STATES becomes one of the schema's enum
 * values. Written down once, here, and used by three things that must agree:
 * the labeller deciding a label, the evidence check confirming it, and the
 * citation check deciding whether a cited span grounds an extracted type.
 *
 * Filings never say "mixed-use". They say "Office / Retail". So a span naming
 * two or more of the four use categories maps to mixed-use; one maps to that
 * category; none, but a non-use term ("Land", "Studio"), maps to other; and
 * nothing recognisable maps to null — the document did not state a type.
 *
 * A portfolio-level sentence ("predominantly retail") is not a statement about
 * any one property, and is not labelled as one. See docs/extraction-eval.md.
 */
export const PROPERTY_TYPE_TERMS = {
  office: /\boffices?\b/i,
  retail: /\bretail\b|shopping\s+cent(?:er|re)s?\b|\bmall\b/i,
  industrial: /industrial|warehouse|distribution|manufacturing|\bflex\b/i,
  multifamily: /multi-?\s?family|\bapartments?\b|\bresidential\b/i,
};
const OTHER_TYPE_TERMS = /\bland\b|\bstudios?\b|\btheat(?:er|re)\b|\bhotel\b|\bgarage\b|\bshowroom\b/i;

/** @returns {string|null} the enum value a stated type label maps to */
export function classifyPropertyType(stated) {
  if (typeof stated !== 'string') return null;
  const hits = Object.entries(PROPERTY_TYPE_TERMS)
    .filter(([, re]) => re.test(stated))
    .map(([name]) => name);
  if (hits.length >= 2) return 'mixed-use';
  if (hits.length === 1) return hits[0];
  return OTHER_TYPE_TERMS.test(stated) ? 'other' : null;
}

/**
 * Does a span of document text state `value`? Digits first, separators
 * stripped, so "$12,400,000" holds 12400000 and "6.25%" holds 6.25. Then a
 * number with a scale word, so "$123.5 million" holds 123500000: the digits
 * of the two differ, and a literal check would call a correctly cited prose
 * figure ungrounded. The scaled match is exact, not within a tolerance; the
 * tolerance belongs to the comparator, not to the citation check.
 */
const SCALES = { thousand: 1e3, million: 1e6, billion: 1e9 };
export function spanHoldsNumber(span, value) {
  if (typeof span !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) return false;
  const digits = String(value).replace(/[^0-9]/g, '');
  if (digits.length > 0 && span.replace(/[^0-9]/g, '').includes(digits)) return true;
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion)\b/gi;
  let m;
  while ((m = re.exec(span))) {
    const n = Number(m[1].replace(/,/g, '')) * SCALES[m[2].toLowerCase()];
    if (Math.abs(n - value) <= Math.abs(value) * 1e-9) return true;
  }
  return false;
}

/** @returns {{name:string, kind:FieldKind, required:boolean}} */
export function fieldByName(name) {
  const f = FIELDS.find((x) => x.name === name);
  if (!f) throw new Error(`unknown field: ${name}`);
  return f;
}

/**
 * True when `predicted` should count as the same answer as `truth` for `field`.
 * Throws rather than returning false for an unscoreable kind — a field that
 * cannot be judged must stop the run, not quietly contribute a zero.
 */
export function valuesAgree(fieldName, predicted, truth) {
  const { kind } = fieldByName(fieldName);
  const cmp = COMPARATORS[kind];
  if (!cmp) throw new Error(`no comparator for kind: ${kind}`);
  return cmp(predicted, truth);
}
