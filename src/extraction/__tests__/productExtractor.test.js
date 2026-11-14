import { describe, it, expect } from 'vitest';
import {
  buildRequest, parseRecord, recordResponse, locateQuote, renderPages, productPromptSha, validValue,
  OUTPUT_SCHEMA, SYSTEM_PROMPT, MODEL, pageOpen, PAGE_CLOSE,
} from '../productExtractor';
import * as modelExtractor from '../modelExtractor';
import { PRODUCT_FIELDS, PRODUCT_FIELD_NAMES, DRAFT_FIELDS, productFieldByName } from '../schema';

// FIXTURE. A hand-written three-page document in the C1 shape, for testing the
// request builder and the parser. It is not an offering memorandum, describes
// no real property, and no number in this repository comes from it.
const DOC = {
  id: 'doc_fixture', dealId: 'deal_fixture', filename: 'fixture.pdf', sha256: null, byteSize: null,
  pageCount: 3, textLayer: 'present', createdAt: null,
  pages: [
    { page: 1, text: 'FIXTURE OFFERING SUMMARY\n100 Fixture Street\nAsking Price: $18,500,000\nUnits: 120' },
    { page: 2, text: 'FINANCIAL SUMMARY\nGross Potential Rent | $2,160,000\nReal Estate Taxes | $210,000\nAsking Price: $18,500,000' },
    { page: 3, text: 'ASSUMABLE DEBT\nLoan Amount | $11,000,000\nInterest Rate | 4.25%\nAmortization | 30 years' },
  ],
};

// Hand-written RESPONSE SHAPES for testing the parser, not model output.
const empty = { value: null, page: null, quote: null, confidence: null };
const answer = (fields) => Object.fromEntries(PRODUCT_FIELD_NAMES.map((f) => [f, fields[f] ?? empty]));
const record = (fields, over = {}) => ({
  id: 'msg_test', servedModel: MODEL, stopReason: 'end_turn', stopDetails: null,
  text: JSON.stringify(answer(fields)), usage: null, ...over,
});

describe('buildRequest', () => {
  const req = buildRequest({ document: DOC });

  it('follows the model extractor conventions: model, adaptive thinking, high effort, closed schema, no fallback', () => {
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.model).toBe(modelExtractor.MODEL);
    expect(req.thinking).toEqual({ type: 'adaptive' });
    expect(req.output_config.effort).toBe('high');
    expect(req.output_config.format).toEqual({ type: 'json_schema', schema: OUTPUT_SCHEMA });
    expect(req.fallbacks).toBeUndefined();
    expect(req.betas).toBeUndefined();
    expect(req.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT }]);
  });

  it('caches the document block and puts the question after it', () => {
    const [doc, q] = req.messages[0].content;
    expect(doc.cache_control).toEqual({ type: 'ephemeral' });
    expect(q.cache_control).toBeUndefined();
    expect(q.text).toMatch(/property this document offers/);
    expect(buildRequest({ document: DOC, subject: '100 Fixture Street' }).messages[0].content[1].text)
      .toContain('100 Fixture Street');
  });

  it('marks every page explicitly, in order', () => {
    const doc = req.messages[0].content[0].text;
    expect(doc).toBe(`<document>\n${renderPages(DOC.pages)}\n</document>`);
    for (const p of DOC.pages) expect(doc).toContain(`${pageOpen(p.page)}\n${p.text}\n${PAGE_CLOSE}`);
    expect(doc.indexOf(pageOpen(1))).toBeLessThan(doc.indexOf(pageOpen(2)));
    expect(doc.indexOf(pageOpen(2))).toBeLessThan(doc.indexOf(pageOpen(3)));
  });

  it('requires every product field with value, page, quote and confidence, all closed', () => {
    expect(OUTPUT_SCHEMA.required).toEqual(PRODUCT_FIELD_NAMES);
    expect(OUTPUT_SCHEMA.additionalProperties).toBe(false);
    for (const f of PRODUCT_FIELD_NAMES) {
      expect(OUTPUT_SCHEMA.properties[f].required).toEqual(['value', 'page', 'quote', 'confidence']);
      expect(OUTPUT_SCHEMA.properties[f].additionalProperties).toBe(false);
    }
    expect(OUTPUT_SCHEMA.properties.units.properties.value.anyOf[0]).toEqual({ type: 'integer' });
    expect(OUTPUT_SCHEMA.properties.interestRate.properties.value.anyOf[0]).toEqual({ type: 'number' });
    expect(OUTPUT_SCHEMA.properties.operatingExpensesIncludeTaxes.properties.value.anyOf[0])
      .toEqual({ type: 'string', enum: ['includes-taxes', 'excludes-taxes'] });
  });

  it('defines every field in the prompt and says null is a correct answer', () => {
    for (const f of PRODUCT_FIELD_NAMES) expect(SYSTEM_PROMPT).toContain(`- ${f}:`);
    expect(SYSTEM_PROMPT).toMatch(/Null is a correct answer/);
  });

  it('refuses a document with no text layer or misnumbered pages', () => {
    expect(() => buildRequest({ document: { ...DOC, textLayer: 'absent' } })).toThrow(/no text layer/);
    expect(() => buildRequest({ document: { ...DOC, pages: [DOC.pages[1], DOC.pages[0]] } })).toThrow(/malformed/);
    expect(() => buildRequest({ document: {} })).toThrow(/no pages/);
    expect(() => buildRequest({ document: { ...DOC, pages: [], pageCount: 0 } })).toThrow(/no pages/);
    expect(() => buildRequest({ document: { ...DOC, pageCount: 4 } })).toThrow(/says 4 pages and carries 3/);
    expect(() => buildRequest({ document: { ...DOC, pageCount: null } })).not.toThrow();
  });

  it('has its own prompt hash, distinct from the eval prompt, and stable', () => {
    expect(productPromptSha()).toMatch(/^[0-9a-f]{64}$/);
    expect(productPromptSha()).not.toBe(modelExtractor.promptSha());
    expect(productPromptSha()).toBe(productPromptSha());
  });
});

describe('locateQuote: one page at a time', () => {
  it('maps a quote to offsets in that page\'s text', () => {
    const q = 'Loan Amount | $11,000,000';
    const { citation, reason } = locateQuote(DOC.pages, q, 3);
    expect(reason).toBeNull();
    expect(citation).toEqual({ page: 3, start: DOC.pages[2].text.indexOf(q), end: DOC.pages[2].text.indexOf(q) + q.length });
    expect(DOC.pages[2].text.slice(citation.start, citation.end)).toBe(q);
  });

  it('finds the quote on its one page even when the model named the wrong page', () => {
    expect(locateQuote(DOC.pages, 'Units: 120', 2).citation).toMatchObject({ page: 1 });
    expect(locateQuote(DOC.pages, 'Units: 120', null).citation).toMatchObject({ page: 1 });
  });

  it('uses the model\'s page to settle a quote printed on several pages, and abstains when it cannot', () => {
    const q = 'Asking Price: $18,500,000';
    expect(locateQuote(DOC.pages, q, 2).citation).toMatchObject({ page: 2, start: DOC.pages[1].text.indexOf(q) });
    expect(locateQuote(DOC.pages, q, 1).citation).toMatchObject({ page: 1 });
    expect(locateQuote(DOC.pages, q, 3)).toEqual({ citation: null, reason: 'ambiguous' });
    expect(locateQuote(DOC.pages, q, null)).toEqual({ citation: null, reason: 'ambiguous' });
  });

  it('does not place a quote that runs across a page boundary', () => {
    const joinedPlain = `${DOC.pages[0].text}\n${DOC.pages[1].text}`;
    const cross = 'Units: 120\nFINANCIAL SUMMARY';
    expect(joinedPlain).toContain(cross);
    expect(locateQuote(DOC.pages, cross, 1)).toEqual({ citation: null, reason: 'not-found' });
    const crossMarker = `Units: 120\n${PAGE_CLOSE}\n${pageOpen(2)}\nFINANCIAL SUMMARY`;
    expect(renderPages(DOC.pages)).toContain(crossMarker);
    expect(locateQuote(DOC.pages, crossMarker, 1)).toEqual({ citation: null, reason: 'not-found' });
  });

  it('does not place a paraphrase, and does not place a missing quote', () => {
    expect(locateQuote(DOC.pages, 'Loan amount: $11.0 million', 3)).toEqual({ citation: null, reason: 'not-found' });
    expect(locateQuote(DOC.pages, null, 3)).toEqual({ citation: null, reason: 'no-quote' });
    expect(locateQuote(DOC.pages, '', 3)).toEqual({ citation: null, reason: 'no-quote' });
  });
});

describe('parseRecord (contract C2)', () => {
  it('returns C2 predictions with located citations', () => {
    const { prediction, error, unlocatedQuotes } = parseRecord(record({
      units: { value: 120, page: 1, quote: 'Units: 120', confidence: 0.95 },
      interestRate: { value: 4.25, page: 3, quote: 'Interest Rate | 4.25%', confidence: 0.9 },
    }), DOC);
    expect(error).toBeNull();
    expect(unlocatedQuotes).toEqual([]);
    expect(prediction.units).toEqual({
      value: 120, quality: 'sourced', confidence: 0.95,
      citation: { page: 1, start: DOC.pages[0].text.indexOf('Units: 120'), end: DOC.pages[0].text.indexOf('Units: 120') + 10 },
    });
    expect(prediction.interestRate.citation.page).toBe(3);
  });

  it('keeps an ungrounded value with citation null and reports why, rather than hiding it', () => {
    const { prediction, unlocatedQuotes } = parseRecord(record({
      loanAmount: { value: 11_000_000, page: 3, quote: 'Loan amount: $11.0 million', confidence: 0.8 },
      askingPrice: { value: 18_500_000, page: null, quote: 'Asking Price: $18,500,000', confidence: 0.9 },
      units: { value: 120, page: 1, quote: null, confidence: 0.9 },
      grossPotentialRent: { value: 2_160_000, page: 1, quote: 'Units: 120\nFINANCIAL SUMMARY', confidence: 0.5 },
    }), DOC);
    expect(prediction.loanAmount).toMatchObject({ value: 11_000_000, quality: 'sourced', citation: null });
    expect(prediction.askingPrice.citation).toBeNull();
    expect(prediction.units.citation).toBeNull();
    expect(prediction.grossPotentialRent.citation).toBeNull();
    expect(unlocatedQuotes).toEqual([
      { field: 'units', reason: 'no-quote' },
      { field: 'grossPotentialRent', reason: 'not-found' },
      { field: 'askingPrice', reason: 'ambiguous' },
      { field: 'loanAmount', reason: 'not-found' },
    ]);
  });

  it('treats null as abstention and drops a value of the wrong type without coercing it', () => {
    const { prediction, invalidValues } = parseRecord(record({
      units: { value: '120', page: 1, quote: 'Units: 120', confidence: 0.9 },
      interestRate: { value: 4.25, page: 3, quote: 'Interest Rate | 4.25%', confidence: 'high' },
      operatingExpensesIncludeTaxes: { value: 'yes', page: 2, quote: 'Real Estate Taxes', confidence: 0.5 },
    }), DOC);
    expect(prediction.units).toBeUndefined();
    expect(prediction.operatingExpensesIncludeTaxes).toBeUndefined();
    expect(invalidValues).toEqual(['units', 'operatingExpensesIncludeTaxes']);
    expect(prediction.interestRate.confidence).toBeNull();
    expect(parseRecord(record({}), DOC).prediction).toEqual({});
  });

  it('reads a confidence outside 0 to 1 as unknown, never clamped', () => {
    const { prediction } = parseRecord(record({
      units: { value: 120, page: 1, quote: 'Units: 120', confidence: 1.7 },
      interestRate: { value: 4.25, page: 3, quote: 'Interest Rate | 4.25%', confidence: -0.2 },
      loanAmount: { value: 11_000_000, page: 3, quote: 'Loan Amount | $11,000,000', confidence: 1 },
      grossPotentialRent: { value: 2_160_000, page: 2, quote: 'Gross Potential Rent | $2,160,000', confidence: 0 },
    }), DOC);
    expect(prediction.units.confidence).toBeNull();
    expect(prediction.interestRate.confidence).toBeNull();
    expect(prediction.loanAmount.confidence).toBe(1);
    expect(prediction.grossPotentialRent.confidence).toBe(0);
  });

  it('abstains on everything for a refusal, a truncation, unparseable output, or another model, and says which', () => {
    const fields = { units: { value: 120, page: 1, quote: 'Units: 120', confidence: 0.9 } };
    const none = { prediction: {}, unlocatedQuotes: [], invalidValues: [] };
    expect(parseRecord(record(fields, { stopReason: 'refusal', stopDetails: { category: 'cyber' } }), DOC))
      .toEqual({ ...none, error: 'refusal:cyber' });
    expect(parseRecord(record(fields, { stopReason: 'max_tokens' }), DOC)).toEqual({ ...none, error: 'stop:max_tokens' });
    expect(parseRecord(record(fields, { text: '{"units": ' }), DOC)).toEqual({ ...none, error: 'unparseable' });
    expect(parseRecord(record(fields, { text: 'null' }), DOC)).toEqual({ ...none, error: 'unparseable' });
    expect(parseRecord(record(fields, { servedModel: 'claude-opus-4-8' }), DOC))
      .toEqual({ ...none, error: 'served-by:claude-opus-4-8' });
    expect(parseRecord(record(fields, { servedModel: null }), DOC).error).toBe('served-by:unknown');
    expect(parseRecord(undefined, DOC)).toEqual({ ...none, error: 'missing' });
  });

  it('records only what is needed to re-parse and audit', () => {
    expect(recordResponse({
      id: 'msg_1', model: MODEL, stop_reason: 'end_turn', stop_details: null,
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{}' }], usage: { input_tokens: 1 },
    })).toEqual({ id: 'msg_1', servedModel: MODEL, stopReason: 'end_turn', stopDetails: null, text: '{}', usage: { input_tokens: 1 } });
  });
});

describe('validValue', () => {
  it('checks each kind', () => {
    const f = (n) => productFieldByName(n);
    expect(validValue(f('units'), 120)).toBe(true);
    expect(validValue(f('units'), 120.5)).toBe(false);
    expect(validValue(f('askingPrice'), Infinity)).toBe(false);
    expect(validValue(f('address'), '  ')).toBe(false);
    expect(validValue(f('propertyType'), 'office')).toBe(true);
    expect(validValue(f('propertyType'), 'hotel')).toBe(false);
    expect(validValue({ kind: 'mystery' }, 1)).toBe(false);
    for (const d of DRAFT_FIELDS) expect(PRODUCT_FIELDS).toContain(d);
  });
});
