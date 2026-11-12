/**
 * The model-based extractor: Claude reads the canonical filing text and answers
 * the schema's fields for one property, quoting the text each value came from.
 *
 * This module is pure: it builds requests and parses responses, and makes no
 * network calls. scripts/extract-model.mjs sends the requests and caches every
 * response under eval/predictions/; scripts/eval.mjs scores the cache. So a
 * number from this extractor is always reproducible from committed data, and
 * spending money is always a deliberate, separate act.
 *
 * Three decisions were fixed before this was written (docs/extraction-eval.md,
 * "Model-based extractor: pre-registration"):
 *
 *   - A value's citation is located HERE, by exact match of the model's quote
 *     in the canonical text. The model never supplies offsets, and a non-null
 *     value without a locatable quote is scored ungrounded. There is no way to
 *     answer and skip the grounding check.
 *   - No refusal fallback. A refusal abstains on every field and is counted.
 *   - The prompt and schema are hashed. The holdout set runs only under the
 *     frozen hash, so the prompt cannot be revised after the holdout is seen.
 */

import { createHash } from 'node:crypto';
import { FIELDS } from './schema.js';

export const MODEL = 'claude-opus-5-5';
export const EFFORT = 'high';
export const MAX_TOKENS = 16000;

/**
 * Sets the runner may score, and which of them are held out. A held-out set
 * runs only under FROZEN_PROMPT_SHA.
 */
export const DEVELOPMENT_SETS = ['dev', 'holdout', 'holdout2', 'filing5'];
export const HOLDOUT_SETS = ['filing6'];

/**
 * Null until the prompt is frozen. Set in the commit that freezes it, before
 * the sixth filing is fetched; never edited after its score is seen.
 */
export const FROZEN_PROMPT_SHA = null;

export const SYSTEM_PROMPT = `You extract facts about one commercial real estate property from a public SEC filing, for an evaluation that measures whether every answer is read from the document.

The filing is given as plain text converted from HTML. Each table row is one line, with cells separated by " | ". Empty cells were dropped, so a short row may not say which column a value belongs to. When the column is genuinely ambiguous, return null.

Answer only what the filing states about the named property. A field the filing does not state is null. Null is a correct answer and is scored as one; a plausible value the filing does not state is scored as an invented fact. Do not compute, estimate or infer a value: a cap rate derived from NOI and price, a year built derived from an "age", or a figure for a portfolio applied to one property are all null.

Fields:
- address: a street address printed for this property, with a building number, exactly as printed. A property name, a city, or a street with no number is not an address.
- propertyType: one of office, retail, industrial, multifamily, mixed-use, other, as the filing states the property's type: in a type column, in a heading the property's row sits under, through a legend that defines a type code, or in a type word in the property's own name. A stated type naming two or more of office / retail / industrial / multifamily is mixed-use. A stated type outside those four (land, laboratory, clinic, courthouse, studio, specialized facility) is other. A heading naming two categories over a whole table does not type its rows.
- squareFeet: the property's size in square feet as the filing states it. Where in-service and total are both given, the total. Leased square feet is not the property's size. Units are not square feet.
- yearBuilt: a single four-digit construction year. When several years are listed ("1911/2009", "1948, 1975"), the first. When the first is a range ("1990-2004"), null.
- purchasePrice: a price stated for acquiring this property, in dollars. Cost basis, mortgages, refinancings, sale prices and prices for several properties together are not this property's purchase price.
- netOperatingIncome: net operating income stated for this property alone, in dollars.
- capRate: a capitalization rate stated for this property, in percentage points (6.25 for 6.25%, never 0.0625).
- occupancy: a figure the filing calls occupancy for this property, most recent date or period, in percentage points. "Percentage leased", or space "occupied or subject to a lease", is not occupancy.

When the same field is stated twice and disagrees, use the figure in the per-property table the property is listed in.

For every non-null value, give quote: a short span copied character for character from the filing text that contains the value, including any " | " separators exactly as they appear. The quote is checked by exact string match. Give confidence between 0 and 1 for each non-null value: your probability that the value is correct.`;

/** Field-level JSON schema: a value or null, the quote it came from, a confidence. */
function fieldSchema(field) {
  let value;
  switch (field.kind) {
    case 'money':
    case 'area':
    case 'percent':
      value = { anyOf: [{ type: 'number' }, { type: 'null' }] };
      break;
    case 'year':
      value = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
      break;
    case 'enum':
      value = { anyOf: [{ type: 'string', enum: field.options }, { type: 'null' }] };
      break;
    default:
      value = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  }
  return {
    type: 'object',
    properties: {
      value,
      quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      confidence: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    },
    required: ['value', 'quote', 'confidence'],
    additionalProperties: false,
  };
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(FIELDS.map((f) => [f.name, fieldSchema(f)])),
  required: FIELDS.map((f) => f.name),
  additionalProperties: false,
};

export const question = (subject) => `Extract the fields for this property, as the filing above names it: ${subject}`;

/** The hash the freeze is checked against: everything that shapes an answer. */
export function promptSha() {
  return createHash('sha256').update(JSON.stringify({
    model: MODEL, effort: EFFORT, system: SYSTEM_PROMPT, schema: OUTPUT_SCHEMA, question: question('{subject}'),
  })).digest('hex');
}

/**
 * Messages API parameters for one (filing, property) item.
 *
 * The filing goes first, in its own block marked for caching, so every
 * property of a filing after the first reads it from cache. Stable content
 * (system prompt, filing) comes before the per-property question; nothing
 * volatile sits in the cached prefix.
 */
export function buildRequest({ text, subject }) {
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
        { type: 'text', text: `<filing>\n${text}\n</filing>`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: question(subject) },
      ],
    }],
  };
}

/**
 * The part of a response worth caching: enough to re-parse, audit cost and
 * see which model served it, and nothing else.
 */
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
 * A cached response to the scorer's prediction shape.
 *
 * @param {Object} record  from recordResponse
 * @param {string} text    the canonical filing text the request was built from
 * @returns {{prediction:Object, error:string|null, unlocatedQuotes:string[]}}
 */
export function parseRecord(record, text) {
  if (!record) return { prediction: {}, error: 'missing', unlocatedQuotes: [] };
  if (record.stopReason === 'refusal') {
    return { prediction: {}, error: `refusal:${record.stopDetails?.category ?? 'unknown'}`, unlocatedQuotes: [] };
  }
  if (record.stopReason !== 'end_turn') {
    return { prediction: {}, error: `stop:${record.stopReason}`, unlocatedQuotes: [] };
  }
  if (record.servedModel && record.servedModel !== MODEL) {
    // Fallbacks are off, so this should not happen; if it does, the answer is
    // not this extractor's and must not be scored as one.
    return { prediction: {}, error: `served-by:${record.servedModel}`, unlocatedQuotes: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(record.text);
  } catch {
    return { prediction: {}, error: 'unparseable', unlocatedQuotes: [] };
  }

  const prediction = {};
  const unlocatedQuotes = [];
  for (const f of FIELDS) {
    const a = parsed?.[f.name];
    if (!a || a.value === null || a.value === undefined) continue;
    const quote = typeof a.quote === 'string' && a.quote ? a.quote : null;
    const at = quote ? text.indexOf(quote) : -1;
    if (quote && at < 0) unlocatedQuotes.push(f.name);
    prediction[f.name] = {
      value: a.value,
      quality: 'sourced',
      confidence: typeof a.confidence === 'number' ? a.confidence : null,
      // Exact match or nothing: a quote that is not in the document leaves the
      // citation null, and the scorer counts the answer ungrounded.
      citation: at >= 0 ? { page: 1, start: at, end: at + quote.length } : null,
    };
  }
  return { prediction, error: null, unlocatedQuotes };
}

/** The runner calls this before sending a single request for a set. */
export function assertRunnable(set, sha = promptSha()) {
  if (DEVELOPMENT_SETS.includes(set)) return;
  if (!HOLDOUT_SETS.includes(set)) throw new Error(`unknown set: ${set}`);
  if (!FROZEN_PROMPT_SHA) {
    throw new Error(`${set} is held out and the prompt is not frozen. Freeze it (set FROZEN_PROMPT_SHA) `
      + 'and commit before running the holdout.');
  }
  if (sha !== FROZEN_PROMPT_SHA) {
    throw new Error(`${set} is held out: the prompt hash ${sha.slice(0, 12)} is not the frozen `
      + `${FROZEN_PROMPT_SHA.slice(0, 12)}. The prompt may not change after the freeze.`);
  }
}

/** Opus 5.5 list prices per million tokens, for cost reporting only. */
export const PRICES = { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 };

export function costOf(usage) {
  if (!usage) return 0;
  return ((usage.input_tokens || 0) * PRICES.input
    + (usage.output_tokens || 0) * PRICES.output
    + (usage.cache_creation_input_tokens || 0) * PRICES.cacheWrite5m
    + (usage.cache_read_input_tokens || 0) * PRICES.cacheRead) / 1e6;
}
