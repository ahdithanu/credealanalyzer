/**
 * The product extractor: Claude reads one uploaded document (contract C1, a
 * multi-page offering memorandum or similar) and answers every PRODUCT_FIELDS
 * field, quoting the text each value came from.
 *
 * Like modelExtractor.js, this module is pure. It builds the request and parses
 * the response; it makes no network calls. It is a separate module, with its
 * own prompt and its own hash, so that nothing here can move the eval:
 * modelExtractor.js, its prompt and its hash stay byte-identical, and a test
 * pins them.
 *
 * WHAT IS AND IS NOT MEASURED. The eval measured modelExtractor's prompt on
 * SEC filings. This prompt is different and its documents are different, so
 * even the eight `measured: true` fields have no measured accuracy UNDER THIS
 * PROMPT. The draft fields have no eval at all. See docs/product-fields.md.
 *
 * The conventions carried over from modelExtractor.js, deliberately:
 *
 *   - The citation is located HERE, by exact match of the model's quote in one
 *     page's text. The model never supplies offsets. A quote that is not found,
 *     that is found on several pages and the model's page does not settle it,
 *     or that runs across a page boundary, gives citation null. The value is
 *     still returned, and must be shown as ungrounded, never hidden.
 *   - No refusal fallback. A refusal, a truncation, unparseable output or a
 *     different serving model abstains on every field and reports the error.
 *   - The prompt and schema are hashed (productPromptSha), so a stored
 *     prediction can always say which prompt produced it.
 */

// Not node:crypto: the review screen imports the parser in the browser.
import { sha256Hex } from './sha256.js';
import { PRODUCT_FIELDS } from './schema.js';

export const MODEL = 'claude-opus-5-5';
export const EFFORT = 'high';
export const MAX_TOKENS = 16000;

/** How each page is marked in the request. The parser relies on this shape. */
export const pageOpen = (n) => `<page number="${n}">`;
export const PAGE_CLOSE = '</page>';

export const SYSTEM_PROMPT = `You extract underwriting facts about one commercial real estate property from a document a user uploaded, usually an offering memorandum, a broker package or a loan term sheet. Your answers fill a form that a human underwriter reviews field by field before any value reaches a financial model.

The document is given as plain text, page by page. Each page is wrapped in <page number="N"> ... </page>. Text extracted from tables may have lost its column alignment; when it is genuinely unclear which column or which year a figure belongs to, return null.

Answer only what the document states about the property it offers. A field the document does not state is null. Null is a correct answer, and it is the answer the underwriter needs when the document is silent: a plausible value the document does not state is an invented fact, and it will be treated as one. Do not compute, estimate or infer a value. A figure you would have to add up, divide, annualize, or carry over from a different property, a different year or a market average is null, unless the field below says otherwise.

Where the document states both a current ("in-place", "actual", "trailing twelve months") figure and a projected ("pro forma", "Year 1", "stabilized") figure, give the current one. Where it states only a projection, give null; do not give the projection as if it were current.

Fields:
- address: a street address printed for the property, with a building number, exactly as printed. A property name, a city, or a street with no number is not an address.
- propertyType: one of office, retail, industrial, multifamily, mixed-use, other, as the document states the property's type. A stated type naming two or more of office / retail / industrial / multifamily is mixed-use. A stated type outside those four (land, hotel, self storage, medical, laboratory, car wash) is other.
- squareFeet: the property's size in square feet as the document states it: the building's rentable or gross area, whichever the document gives as the property's size. Leased square feet, land area and acres are not the property's size. Units are not square feet.
- yearBuilt: a single four-digit construction year. When several years are listed ("1985 / 2015 renovation"), the first. When the first is a range, null.
- purchasePrice: a price at which this property was actually bought or is under contract, in dollars. An asking price is not a purchase price; it is askingPrice. A valuation, an appraisal or a loan amount is neither.
- netOperatingIncome: annual net operating income stated for this property alone, current (in-place or trailing), in dollars. A pro forma NOI is null here.
- capRate: a capitalization rate stated for this property at the current price and current NOI, in percentage points (6.25 for 6.25%, never 0.0625). A pro forma or stabilized cap rate is null here.
- occupancy: a figure the document calls occupancy (physical or economic) for this property, most recent date, in percentage points. "Percent leased" is not occupancy unless the document says the two are the same.
- units: the number of residential units (or hotel keys, or self storage units) the document states for the property, as an integer. Square feet and tenant counts are not units. For a property with no units (most office, retail and industrial), null.
- grossPotentialRent: annual gross potential rent, in dollars, as the document states it: rent at 100% occupancy before vacancy and credit loss. Effective gross income, total revenue and "total income" are not gross potential rent. A monthly figure is not this field: do not multiply it by twelve; give null.
- operatingExpenses: the document's stated total annual operating expenses for the property, current, in dollars, as one figure the document prints. Do not add up line items. Capital expenditures, reserves and debt service are not operating expenses.
- operatingExpensesIncludeTaxes: includes-taxes if the stated operatingExpenses total includes real estate taxes (for example, taxes appear as a line item above the total), excludes-taxes if the document shows the total without them. Null when operatingExpenses is null or the document does not make it clear.
- realEstateTaxes: annual real estate (property) taxes for the property, current, in dollars, as stated. A tax rate, an assessed value or a monthly escrow is not this field.
- askingPrice: the price at which the property is offered, in dollars, as stated. "Unpriced", "call for offers" or "best and final" with no figure is null. A price per unit or per square foot alone is null; do not multiply it out.
- loanAmount: the principal amount of a loan on this property that the document states, in dollars: the existing loan for an assumable debt, or the proposed loan in a term sheet. A loan-to-value percentage alone is null.
- interestRate: the annual interest (note) rate of that loan, in percentage points (5.25 for 5.25%, never 0.0525). A floating rate stated only as a spread over an index ("SOFR + 275") is null: it has no single rate.
- amortizationYears: the amortization period of that loan, in years. 360 months is 30. Interest-only with no amortization is null.
- loanTermYears: the term of that loan to maturity, in years, as stated. A maturity date without a stated term is null; do not count the years.
- weightedAverageLeaseTerm: the weighted average remaining lease term (WALT or WALE) the document states for the property, in years. 66 months is 5.5. Do not compute it from a rent roll.

When the same field is stated twice and disagrees, use the figure in the document's own summary of the property (its executive summary or financial summary page).

For every non-null value, give quote: a short span copied character for character from ONE page of the document that contains the value, and page: the number of that page. A quote must not run from one page into the next. The quote is checked by exact string match against that page's text. Give confidence between 0 and 1 for each non-null value: your probability that the value is correct.`;

/** Field-level JSON schema: a value or null, the page and quote it came from, a confidence. */
function fieldSchema(field) {
  let value;
  switch (field.kind) {
    case 'money':
    case 'area':
    case 'percent':
    case 'rate':
    case 'duration':
      value = { anyOf: [{ type: 'number' }, { type: 'null' }] };
      break;
    case 'year':
    case 'count':
      value = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
      break;
    case 'enum':
      value = { anyOf: [{ type: 'string', enum: field.options }, { type: 'null' }] };
      break;
    case 'text':
      value = { anyOf: [{ type: 'string' }, { type: 'null' }] };
      break;
    default:
      // A kind this module does not know must not quietly become free text.
      throw new Error(`no output schema for kind: ${field.kind}`);
  }
  return {
    type: 'object',
    properties: {
      value,
      page: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      confidence: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    },
    required: ['value', 'page', 'quote', 'confidence'],
    additionalProperties: false,
  };
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(PRODUCT_FIELDS.map((f) => [f.name, fieldSchema(f)])),
  required: PRODUCT_FIELDS.map((f) => f.name),
  additionalProperties: false,
};

export const question = (subject) => (subject
  ? `Extract the fields for this property, as the document above names it: ${subject}`
  : 'Extract the fields for the property this document offers.');

/** The hash a stored prediction is tagged with: everything that shapes an answer. */
export function productPromptSha() {
  return sha256Hex(JSON.stringify({
    model: MODEL,
    effort: EFFORT,
    system: SYSTEM_PROMPT,
    schema: OUTPUT_SCHEMA,
    question: [question('{subject}'), question(null)],
    pages: [pageOpen('{n}'), PAGE_CLOSE],
  }));
}

/** The document's pages as the request presents them. */
export function renderPages(pages) {
  return pages.map((p) => `${pageOpen(p.page)}\n${p.text}\n${PAGE_CLOSE}`).join('\n');
}

function checkPages(document) {
  if (!document || !Array.isArray(document.pages)) throw new Error('document has no pages');
  if (document.textLayer === 'absent') throw new Error('document has no text layer');
  document.pages.forEach((p, i) => {
    if (p.page !== i + 1 || typeof p.text !== 'string') {
      throw new Error(`page ${i + 1} is malformed: pages must be numbered 1..n in order with text`);
    }
  });
}

/**
 * Messages API parameters for one C1 document.
 *
 * The document goes first, in its own block marked for caching, so a re-run
 * on the same document reads it from cache. The system prompt and document are
 * stable; the question comes after them.
 *
 * @param {{document: Object, subject?: string}} args  document is contract C1
 */
export function buildRequest({ document, subject = null }) {
  checkPages(document);
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    system: [{ type: 'text', text: SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `<document>\n${renderPages(document.pages)}\n</document>`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: question(subject) },
      ],
    }],
  };
}

/** The part of a response worth keeping: enough to re-parse and audit. */
export function recordResponse(message) {
  const textBlock = (message.content || []).find((b) => b.type === 'text');
  return {
    id: message.id ?? null,
    servedModel: message.model ?? null,
    stopReason: message.stop_reason ?? null,
    stopDetails: message.stop_details ?? null,
    text: textBlock ? textBlock.text : null,
    usage: message.usage ?? null,
  };
}

/**
 * Where a quote sits, as a C2 citation, or why it cannot be placed.
 *
 * Searched one page at a time, never in the concatenation, so a quote that
 * runs across a page boundary is not found on any page. When the model's page
 * holds the quote, that page; otherwise the one page that holds it; otherwise
 * (no page, or several and the model's page is not among them) null.
 *
 * @returns {{citation: {page,start,end}|null, reason: null|'no-quote'|'not-found'|'ambiguous'}}
 */
export function locateQuote(pages, quote, statedPage) {
  if (typeof quote !== 'string' || quote.length === 0) return { citation: null, reason: 'no-quote' };
  const at = (p) => p.text.indexOf(quote);
  const stated = pages.find((p) => p.page === statedPage);
  if (stated && at(stated) >= 0) {
    const start = at(stated);
    return { citation: { page: stated.page, start, end: start + quote.length }, reason: null };
  }
  const holders = pages.filter((p) => at(p) >= 0);
  if (holders.length === 1) {
    const start = at(holders[0]);
    return { citation: { page: holders[0].page, start, end: start + quote.length }, reason: null };
  }
  return { citation: null, reason: holders.length === 0 ? 'not-found' : 'ambiguous' };
}

/** Is `v` a value this field's kind can hold? The output schema says so; this checks. */
export function validValue(field, v) {
  switch (field.kind) {
    case 'money': case 'area': case 'percent': case 'rate': case 'duration':
      return typeof v === 'number' && Number.isFinite(v);
    case 'year': case 'count':
      return Number.isInteger(v);
    case 'enum':
      return typeof v === 'string' && field.options.includes(v);
    case 'text':
      return typeof v === 'string' && v.trim().length > 0;
    default:
      return false;
  }
}

const abstain = (error) => ({ prediction: {}, error, unlocatedQuotes: [], invalidValues: [] });

/**
 * A stored response to contract C2 predictions.
 *
 * @param {Object} record    from recordResponse
 * @param {Object} document  the C1 document the request was built from
 * @returns {{prediction:Object, error:string|null,
 *            unlocatedQuotes:Array<{field:string, reason:string}>, invalidValues:string[]}}
 */
export function parseRecord(record, document) {
  if (!record) return abstain('missing');
  if (record.stopReason === 'refusal') return abstain(`refusal:${record.stopDetails?.category ?? 'unknown'}`);
  if (record.stopReason !== 'end_turn') return abstain(`stop:${record.stopReason}`);
  if (record.servedModel !== MODEL) {
    // Fallbacks are off, so this should not happen. If it does, or the record
    // does not say who served it, the answer is not this extractor's.
    return abstain(`served-by:${record.servedModel ?? 'unknown'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(record.text);
  } catch {
    return abstain('unparseable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return abstain('unparseable');

  const pages = document?.pages ?? [];
  const prediction = {};
  const unlocatedQuotes = [];
  const invalidValues = [];
  for (const f of PRODUCT_FIELDS) {
    const a = parsed[f.name];
    if (!a || a.value === null || a.value === undefined) continue;
    if (!validValue(f, a.value)) {
      // A value of the wrong type is not an answer. Dropped (the field reads
      // as not extracted) and reported, never coerced into a number.
      invalidValues.push(f.name);
      continue;
    }
    const { citation, reason } = locateQuote(pages, a.quote, a.page);
    if (!citation) unlocatedQuotes.push({ field: f.name, reason });
    prediction[f.name] = {
      value: a.value,
      quality: 'sourced',
      confidence: typeof a.confidence === 'number' && Number.isFinite(a.confidence) ? a.confidence : null,
      citation,
    };
  }
  return { prediction, error: null, unlocatedQuotes, invalidValues };
}
