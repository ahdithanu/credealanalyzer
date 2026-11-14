import { describe, it, expect } from 'vitest';
import {
  buildRequest, recordResponse, parseRecord, promptSha, assertRunnable, OUTPUT_SCHEMA,
  MODEL, SYSTEM_PROMPT, FROZEN_PROMPT_SHA, costOf,
} from '../modelExtractor';
import { scoreDocument } from '../score';
import { pageReader } from '../text';
import { FIELD_NAMES } from '../schema';

// Verbatim line from the Vornado filing's canonical text.
const DOC = 'NEW YORK SEGMENT Property | % Ownership | Type | % Occupancy | In Service | Under Development or Not Available for Lease | Total Property\n'
  + '1290 Avenue of the Americas | 70.0% | Office / Retail | 91.3% | 2,089,000 | — | 2,089,000';

// These are hand-written RESPONSE SHAPES for testing the parser, not model
// output and not results: no number in this repository comes from them.
const answer = (fields) => Object.fromEntries(FIELD_NAMES.map((f) => [f, fields[f] ?? { value: null, quote: null, confidence: null }]));
const record = (fields, over = {}) => ({
  id: 'msg_test', servedModel: MODEL, stopReason: 'end_turn', stopDetails: null,
  text: JSON.stringify(answer(fields)), usage: null, ...over,
});

describe('buildRequest', () => {
  const req = buildRequest({ text: DOC, subject: '1290 Avenue of the Americas' });

  it('caches the filing and keeps the question after it', () => {
    const [doc, q] = req.messages[0].content;
    expect(doc.cache_control).toEqual({ type: 'ephemeral' });
    expect(doc.text).toContain(DOC);
    expect(q.cache_control).toBeUndefined();
    expect(q.text).toContain('1290 Avenue of the Americas');
  });

  it('asks the pre-registered model, with no fallback and structured output', () => {
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.fallbacks).toBeUndefined();
    expect(req.betas).toBeUndefined();
    expect(req.thinking).toEqual({ type: 'adaptive' });
    expect(req.output_config.effort).toBe('high');
    expect(req.output_config.format).toEqual({ type: 'json_schema', schema: OUTPUT_SCHEMA });
  });

  it('requires every field and a quote with every answer, with closed objects throughout', () => {
    expect(OUTPUT_SCHEMA.required).toEqual(FIELD_NAMES);
    expect(OUTPUT_SCHEMA.additionalProperties).toBe(false);
    for (const f of FIELD_NAMES) {
      expect(OUTPUT_SCHEMA.properties[f].required).toEqual(['value', 'quote', 'confidence']);
      expect(OUTPUT_SCHEMA.properties[f].additionalProperties).toBe(false);
    }
  });
});

describe('parseRecord: citations are located, not believed', () => {
  it('turns an exact quote into a citation the scorer grounds', () => {
    const { prediction, error } = parseRecord(record({
      squareFeet: { value: 2089000, quote: '| — | 2,089,000', confidence: 0.95 },
      occupancy: { value: 91.3, quote: 'Office / Retail | 91.3%', confidence: 0.9 },
    }), DOC);
    expect(error).toBeNull();
    const s = scoreDocument({
      predicted: prediction, truth: { squareFeet: 2089000, occupancy: 91.3 }, pageText: pageReader(DOC),
    });
    expect(s.byField.squareFeet).toMatchObject({ outcome: 'hit', grounded: true, confidence: 0.95 });
    expect(s.byField.occupancy).toMatchObject({ outcome: 'hit', grounded: true });
  });

  it('scores a right value behind a quote that is not in the document as ungrounded', () => {
    // The model paraphrased the row. Exact match or nothing.
    const { prediction, unlocatedQuotes } = parseRecord(record({
      squareFeet: { value: 2089000, quote: 'Total Property: 2,089,000 sq ft', confidence: 0.95 },
    }), DOC);
    expect(prediction.squareFeet.citation).toBeNull();
    expect(unlocatedQuotes).toEqual(['squareFeet']);
    const s = scoreDocument({ predicted: prediction, truth: { squareFeet: 2089000 }, pageText: pageReader(DOC) });
    expect(s.byField.squareFeet).toMatchObject({ outcome: 'hit', grounded: false });
  });

  it('cannot skip the grounding check by leaving the quote out', () => {
    const { prediction } = parseRecord(record({ squareFeet: { value: 2089000, quote: null, confidence: 0.9 } }), DOC);
    expect(prediction.squareFeet.quality).toBe('sourced');
    const s = scoreDocument({ predicted: prediction, truth: { squareFeet: 2089000 }, pageText: pageReader(DOC) });
    expect(s.byField.squareFeet.grounded).toBe(false);
  });

  it('treats a null value as abstention', () => {
    expect(parseRecord(record({}), DOC).prediction).toEqual({});
  });

  it('scores a refusal, a truncation, an unparseable body or another model as abstention, and says which', () => {
    const fields = { squareFeet: { value: 2089000, quote: '2,089,000', confidence: 0.9 } };
    expect(parseRecord(record(fields, { stopReason: 'refusal', stopDetails: { category: 'cyber' } }), DOC))
      .toEqual({ prediction: {}, error: 'refusal:cyber', unlocatedQuotes: [] });
    expect(parseRecord(record(fields, { stopReason: 'max_tokens' }), DOC).error).toBe('stop:max_tokens');
    expect(parseRecord(record(fields, { text: '{"squareFeet": ' }), DOC).error).toBe('unparseable');
    expect(parseRecord(record(fields, { servedModel: 'claude-opus-4-8' }), DOC).error).toBe('served-by:claude-opus-4-8');
    expect(parseRecord(undefined, DOC).error).toBe('missing');
  });

  it('records only what is needed to re-parse and audit', () => {
    const r = recordResponse({
      id: 'msg_1', model: MODEL, stop_reason: 'end_turn', stop_details: null,
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(r).toEqual({
      id: 'msg_1', servedModel: MODEL, stopReason: 'end_turn', stopDetails: null, text: '{}',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });
});

describe('the freeze', () => {
  it('lets development sets run under any prompt', () => {
    expect(() => assertRunnable('dev', 'anything')).not.toThrow();
    expect(() => assertRunnable('filing5', 'anything')).not.toThrow();
  });

  it('refuses the holdout until the prompt is frozen, and under any other prompt after', () => {
    if (FROZEN_PROMPT_SHA === null) {
      expect(() => assertRunnable('filing6')).toThrow(/not frozen/);
    } else {
      expect(() => assertRunnable('filing6', FROZEN_PROMPT_SHA)).not.toThrow();
      expect(() => assertRunnable('filing6', 'f'.repeat(64))).toThrow(/may not change/);
    }
    expect(() => assertRunnable('nonsense')).toThrow(/unknown set/);
  });

  it('hashes everything that shapes an answer', () => {
    expect(promptSha()).toMatch(/^[0-9a-f]{64}$/);
    expect(promptSha()).toBe(promptSha());
    expect(SYSTEM_PROMPT).toContain('Null is a correct answer');
  });
});

describe('cost', () => {
  it('prices cache reads far below fresh input', () => {
    expect(costOf({ input_tokens: 1e6 })).toBe(4);
    expect(costOf({ cache_read_input_tokens: 1e6 })).toBeCloseTo(0.2);
    expect(costOf(null)).toBe(0);
  });
});
