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
// Stated types outside the four use categories. Extended for the fifth filing
// (Easterly), whose legend reads "OC=Outpatient Clinic; SF=Specialized
// Facility; O=Office; C=Courthouse; L=Laboratory; W=Warehouse": a type the
// filing states is still a stated type when the enum has no word for it, and
// the enum's word for it is "other". Extending this list was checked to leave
// every frozen extractor's output unchanged on all five filings.
const OTHER_TYPE_TERMS = /\bland\b|\bstudios?\b|\btheat(?:er|re)\b|\bhotel\b|\bgarage\b|\bshowroom\b|\bclinics?\b|\blaborator(?:y|ies)\b|\bcourthouses?\b|\bspecialized facilit(?:y|ies)\b/i;

function classifyWith(stated, otherTerms) {
  if (typeof stated !== 'string') return null;
  const hits = Object.entries(PROPERTY_TYPE_TERMS)
    .filter(([, re]) => re.test(stated))
    .map(([name]) => name);
  if (hits.length >= 2) return 'mixed-use';
  if (hits.length === 1) return hits[0];
  return otherTerms.test(stated) ? 'other' : null;
}

/** @returns {string|null} the enum value a stated type label maps to */
export function classifyPropertyType(stated) {
  return classifyWith(stated, OTHER_TYPE_TERMS);
}

/**
 * The mapping exactly as the extractors were frozen with it (v1 to v3). They
 * import this, not the current mapping, so that extending the labelling
 * vocabulary cannot change a frozen extractor's answers. It would have: with
 * "courthouse" added, every version started calling Federal Realty's
 * "Courthouse Center", a shopping center, type other.
 */
const OTHER_TYPE_TERMS_V1 = /\bland\b|\bstudios?\b|\btheat(?:er|re)\b|\bhotel\b|\bgarage\b|\bshowroom\b/i;
export function classifyPropertyTypeV1(stated) {
  return classifyWith(stated, OTHER_TYPE_TERMS_V1);
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

// ─── Product fields: what the deal model needs from an offering memorandum ───
//
// Everything below is ADDED for the product and changes nothing above it. The
// eval scores FIELDS through COMPARATORS, and its recorded numbers depend on
// both byte for byte. Nothing below is read by the eval, and a test pins FIELDS
// and the model extractor's prompt hash to their values on the commit this was
// branched from.
//
// THE DRAFT FIELDS HAVE NO EVAL. There are no labels for them, no corpus of
// documents that state them, and no measured accuracy. `measured: false` is
// the flag that says so, and every consumer must show it. A comparator exists
// for each draft kind so that, when an eval is built, "right" is already
// decided and written down here rather than chosen after seeing the scores.

/**
 * Comparators for the kinds only draft fields use. Same contract as
 * COMPARATORS: (predicted, truth), tolerance fixed in advance, non-numbers
 * never agree. Kept out of COMPARATORS so the eval's object is untouched.
 */
export const DRAFT_COMPARATORS = {
  // A unit count is counted, not measured. 240 units against 241 is a
  // different building (or a different reading of a unit mix table), and no
  // marketing convention rounds a unit count.
  count: (pred, truth) => Number.isInteger(pred) && Number.isInteger(truth) && pred === truth,

  // A contract (note) rate in percentage POINTS. Loans are priced to the basis
  // point or the eighth and stated exactly, so the band is half a basis point:
  // wide enough for 5.125 written as 5.13, too narrow for 5.25 against 5.35,
  // which is a different loan. A fraction (0.0525) is wrong, as for `percent`,
  // deliberately.
  rate: (pred, truth) => isNum(pred) && isNum(truth)
    && Math.abs(pred - truth) <= 0.005 + 1e-9,

  // A duration in YEARS (amortization, loan term, WALT). Memoranda quote these
  // to a tenth of a year at most, so the band is half a tenth: 5.4 against
  // 5.42 agrees, 5.4 against 5.5 does not. Months are converted to years before
  // comparison (120 months is 10); 120 against a truth of 10 is wrong, which is
  // the point.
  duration: (pred, truth) => isNum(pred) && isNum(truth)
    && Math.abs(pred - truth) <= 0.05 + 1e-9,
};

/**
 * Underwriting fields an offering memorandum states and this repo's deal model
 * (src/lib/finance.js runModel) takes, or that an underwriter needs in order to
 * convert one. Dollar flows are ANNUAL. docs/product-fields.md says what each
 * maps to, and which map to nothing.
 */
export const DRAFT_FIELDS = [
  { name: 'units', kind: 'count', label: 'Units', unit: 'units', required: false, measured: false },
  { name: 'grossPotentialRent', kind: 'money', label: 'Gross potential rent', unit: 'USD/yr', required: false, measured: false },
  { name: 'operatingExpenses', kind: 'money', label: 'Operating expenses', unit: 'USD/yr', required: false, measured: false },
  { name: 'operatingExpensesIncludeTaxes', kind: 'enum', label: 'Operating expenses include taxes',
    options: ['includes-taxes', 'excludes-taxes'], required: false, measured: false },
  { name: 'realEstateTaxes', kind: 'money', label: 'Real estate taxes', unit: 'USD/yr', required: false, measured: false },
  { name: 'askingPrice', kind: 'money', label: 'Asking price', unit: 'USD', required: false, measured: false },
  { name: 'loanAmount', kind: 'money', label: 'Loan amount', unit: 'USD', required: false, measured: false },
  { name: 'interestRate', kind: 'rate', label: 'Interest rate', unit: '%', required: false, measured: false },
  { name: 'amortizationYears', kind: 'duration', label: 'Amortization', unit: 'years', required: false, measured: false },
  { name: 'loanTermYears', kind: 'duration', label: 'Loan term to maturity', unit: 'years', required: false, measured: false },
  { name: 'weightedAverageLeaseTerm', kind: 'duration', label: 'Weighted average lease term', unit: 'years', required: false, measured: false },
];

const MEASURED_PRESENTATION = {
  address: { label: 'Address' },
  propertyType: { label: 'Property type' },
  squareFeet: { label: 'Square feet', unit: 'sq ft' },
  yearBuilt: { label: 'Year built' },
  purchasePrice: { label: 'Purchase price', unit: 'USD' },
  netOperatingIncome: { label: 'Net operating income', unit: 'USD/yr' },
  capRate: { label: 'Cap rate', unit: '%' },
  occupancy: { label: 'Occupancy', unit: '%' },
};

/**
 * Contract C3. The first FIELDS.length entries are FIELDS, in order, each with
 * a label, a unit where it has one, and `measured: true`; the rest are
 * DRAFT_FIELDS. An eval field with no presentation row throws at import, so a
 * ninth eval field cannot reach the product unlabelled.
 */
export const PRODUCT_FIELDS = [
  ...FIELDS.map((f) => {
    const p = MEASURED_PRESENTATION[f.name];
    if (!p) throw new Error(`no label for eval field: ${f.name}`);
    return { ...f, ...p, measured: true };
  }),
  ...DRAFT_FIELDS,
];

export const PRODUCT_FIELD_NAMES = PRODUCT_FIELDS.map((f) => f.name);

/** Every comparator a product field may use: the eval's, then the draft kinds'. */
export const PRODUCT_COMPARATORS = { ...COMPARATORS, ...DRAFT_COMPARATORS };

export function productFieldByName(name) {
  const f = PRODUCT_FIELDS.find((x) => x.name === name);
  if (!f) throw new Error(`unknown product field: ${name}`);
  return f;
}

/** valuesAgree over PRODUCT_FIELDS. Throws for a kind with no comparator. */
export function productValuesAgree(fieldName, predicted, truth) {
  const { kind } = productFieldByName(fieldName);
  const cmp = PRODUCT_COMPARATORS[kind];
  if (!cmp) throw new Error(`no comparator for kind: ${kind}`);
  return cmp(predicted, truth);
}
