#!/usr/bin/env node
/**
 * Run the model-based extractor over labelled corpus items and cache every
 * response.
 *
 *   npm run extract-model -- --dry-run                 # what it would cost; no API calls
 *   npm run extract-model -- --set=dev                 # one set
 *   npm run extract-model -- --set=dev,holdout,holdout2,filing5
 *   npm run extract-model -- --set=filing6 --run=run2  # holdout: frozen prompt only
 *
 * The key is read from CREDEALANALYZER_ANTHROPIC_API_KEY, else
 * ANTHROPIC_API_KEY. A dedicated name keeps it from changing how anything else
 * in the environment authenticates.
 *
 * Responses go to eval/predictions/<model>.json, keyed by run, prompt hash and
 * item. The runner is resumable: an item already cached under this run and
 * hash is skipped, so an interrupted run costs nothing to finish and a
 * finished one costs nothing to re-score.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { corpusItems } from '../src/extraction/labels.js';
import { htmlToText } from '../src/extraction/text.js';
import {
  MODEL, buildRequest, recordResponse, parseRecord, promptSha, assertRunnable, costOf, PRICES,
} from '../src/extraction/modelExtractor.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus/edgar');
export const PREDICTIONS = join(ROOT, 'eval/predictions', `${MODEL}.json`);

const args = process.argv.slice(2);
const flag = (n, d = null) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const dryRun = args.includes('--dry-run');
const sets = flag('set', 'dev,holdout,holdout2,filing5').split(',');
const run = flag('run', 'run1');
const limit = Number(flag('limit', 'Infinity'));

function load() {
  const manifest = JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8'));
  const texts = {};
  for (const e of manifest) {
    const p = join(CORPUS, e.localPath);
    if (!existsSync(p)) throw new Error(`${e.localPath} missing; refetch with npm run edgar`);
    texts[e.id] = htmlToText(readFileSync(p, 'utf8'));
  }
  return { manifest, texts };
}

async function main() {
  const sha = promptSha();
  for (const s of sets) assertRunnable(s, sha);

  const { manifest, texts } = load();
  const items = sets.flatMap((set) => corpusItems(manifest, { set }))
    .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));

  const store = existsSync(PREDICTIONS) ? JSON.parse(readFileSync(PREDICTIONS, 'utf8')) : { model: MODEL, runs: {} };
  const key = `${run}@${sha.slice(0, 12)}`;
  store.runs[key] ??= { run, promptSha: sha, items: {} };
  const done = store.runs[key].items;
  const todo = items.filter((i) => !done[i.id]).slice(0, limit);

  console.log(`${MODEL}, prompt ${sha.slice(0, 12)}, ${key}: ${items.length} items, ${items.length - todo.length} cached, ${todo.length} to run`);

  if (dryRun) {
    // A rough estimate only: about 3.5 characters a token for this text, one
    // cache write per filing, cache reads after, and a generous output guess.
    const byFiling = {};
    for (const i of todo) byFiling[i.entryId] = (byFiling[i.entryId] || 0) + 1;
    let cost = 0;
    for (const [id, n] of Object.entries(byFiling)) {
      const docTokens = Math.ceil(texts[id].length / 3.5);
      const c = (docTokens * PRICES.cacheWrite5m + (n - 1) * docTokens * PRICES.cacheRead
        + n * 3000 * PRICES.input + n * 4000 * PRICES.output) / 1e6;
      cost += c;
      console.log(`  ${id}: ${n} items, ~${(docTokens / 1000).toFixed(0)}k-token document, ~$${c.toFixed(2)}`);
    }
    console.log(`estimated total ~$${cost.toFixed(2)} (list prices; an estimate, not a quote)`);
    return;
  }

  const apiKey = process.env.CREDEALANALYZER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('No API key. Set CREDEALANALYZER_ANTHROPIC_API_KEY in the environment settings and start a new session.');
    process.exit(2);
  }
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  mkdirSync(dirname(PREDICTIONS), { recursive: true });

  let spent = 0;
  for (const item of todo) {
    const text = texts[item.entryId];
    let record;
    try {
      const message = await client.messages.stream(buildRequest({ text, subject: item.subject })).finalMessage();
      record = recordResponse(message);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        console.error('Authentication failed: check the API key.');
        process.exit(2);
      }
      if (err instanceof Anthropic.BadRequestError) {
        // A malformed request will fail the same way for every item: stop.
        console.error(`400 on ${item.id}: ${err.message}`);
        process.exit(1);
      }
      if (err instanceof Anthropic.APIError) {
        console.error(`API error ${err.status} on ${item.id}: ${err.message}; leaving it uncached`);
        continue;
      }
      throw err;
    }
    done[item.id] = record;
    writeFileSync(PREDICTIONS, `${JSON.stringify(store, null, 2)}\n`);

    const c = costOf(record.usage);
    spent += c;
    const parsed = parseRecord(record, text);
    console.log(`  ${item.set.padEnd(8)} ${item.subject.slice(0, 48).padEnd(48)} `
      + `${parsed.error ?? `${Object.keys(parsed.prediction).length} answered`}`
      + `${parsed.unlocatedQuotes.length ? `, unlocated quotes: ${parsed.unlocatedQuotes.join(',')}` : ''}`
      + `  $${c.toFixed(3)} (cache read ${record.usage?.cache_read_input_tokens ?? 0})`);
  }
  console.log(`spent ~$${spent.toFixed(2)} at list prices`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
