#!/usr/bin/env node
/**
 * Score extractors against the hand-labelled EDGAR corpus.
 *
 *   npm run eval                 # every set, every extractor
 *
 * Sets: `dev` (built against by v1), `holdout` (v1's holdout, then spent as
 * v2's development data), `holdout2` (drawn and labelled after v2 was frozen).
 * `filing5` (12 properties from a fifth REIT 10-K, fetched after v3 was frozen).
 * Only a set an extractor was frozen before is evidence about it.
 *   npm run eval -- --set=dev
 *   npm run eval -- --json       # machine-readable, for diffing runs
 *
 * Refuses to run unless every filing is labelled, every labelled subject is
 * the one the draw put there, every field is labelled explicitly, and every
 * stated value's evidence is found in the document and holds the value. Those
 * checks run on every invocation, not once at labelling time, because the
 * documents are refetched from EDGAR and the converter can change.
 *
 * Read the output as a SET. No extractor is summarised by one number, and the
 * baselines print beside it so that "beats both degenerates" is checked, not
 * asserted. Scores from this corpus are a floor on difficulty, not an estimate
 * of it: see docs/extraction-eval.md for why Schedule III is easier than an OM.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLabelled } from '../src/extraction/edgar.js';
import { assertDrawn, assertCompleteLabels, verifyEvidence, corpusItems } from '../src/extraction/labels.js';
import { htmlToText, pageReader } from '../src/extraction/text.js';
import { scoreDocument, scoreCorpus, BASELINES } from '../src/extraction/score.js';
import { FIELD_NAMES } from '../src/extraction/schema.js';
import { extractFromFiling } from '../src/extraction/tableReader.js';
import { extractFromFiling as extractV1 } from '../src/extraction/tableReaderV1.js';
import { extractFromFiling as extractV2 } from '../src/extraction/tableReaderV2.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus/edgar');

const args = process.argv.slice(2);
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const json = args.includes('--json');
const sets = flag('set') ? [flag('set')] : ['dev', 'holdout', 'holdout2', 'filing5'];

/**
 * The guess the degenerate guesser makes for every field. Constant and
 * genre-typical on purpose; it exists to show what full coverage with no
 * reading costs in hallucinations, not to be right.
 */
export const GUESS_FILLER = {
  address: '1 Main Street',
  propertyType: 'retail',
  squareFeet: 100_000,
  yearBuilt: 1990,
  purchasePrice: 25_000_000,
  netOperatingIncome: 1_500_000,
  capRate: 6.0,
  occupancy: 95.0,
};

const EXTRACTORS = {
  abstainAlways: () => BASELINES.abstainAlways(),
  guessAlways: () => BASELINES.guessAlways(GUESS_FILLER),
  // Frozen copies: v1 as scored at 869c621, v2 as scored at cf32743.
  tableReaderV1: ({ text, subject }) => extractV1(text, subject),
  tableReaderV2: ({ text, subject }) => extractV2(text, subject),
  tableReader: ({ text, subject }) => extractFromFiling(text, subject),
};

function loadCorpus() {
  const manifestPath = join(CORPUS, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath}; run npm run edgar first`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assertLabelled(manifest);

  const texts = {};
  for (const entry of manifest) {
    assertDrawn(entry);
    assertCompleteLabels(entry);
    const path = join(CORPUS, entry.localPath);
    if (!existsSync(path)) {
      throw new Error(`${entry.id}: ${entry.localPath} is missing. The documents are not committed; `
        + `refetch with npm run edgar -- --cik=${Number(entry.cik)} --limit=1`);
    }
    texts[entry.id] = htmlToText(readFileSync(path, 'utf8'));
    verifyEvidence(texts[entry.id], entry);
  }
  return { manifest, texts };
}

function perField(docScores) {
  const out = {};
  for (const name of FIELD_NAMES) {
    out[name] = {};
    for (const d of docScores) {
      const o = d.byField[name].outcome;
      out[name][o] = (out[name][o] || 0) + 1;
    }
  }
  return out;
}

function run() {
  const { manifest, texts } = loadCorpus();
  const report = {};

  const runs = [];
  for (const set of sets) {
    const items = corpusItems(manifest, { set });
    runs.push([set, items]);
    if (items.some((i) => i.alternateTruth)) {
      runs.push([`${set} (alternate labels)`,
        items.map((i) => ({ ...i, truth: { ...i.truth, ...(i.alternateTruth || {}) } }))]);
    }
  }
  for (const [set, items] of runs) {
    if (!items.length) {
      report[set] = { items: 0, note: 'no labelled items in this set' };
      continue;
    }
    report[set] = { items: items.length, extractors: {} };
    for (const [name, extract] of Object.entries(EXTRACTORS)) {
      const docScores = items.map((item) => {
        const text = texts[item.entryId];
        const predicted = extract({ text, subject: item.subject });
        return { item: item.id, ...scoreDocument({ predicted, truth: item.truth, pageText: pageReader(text) }) };
      });
      const corpus = scoreCorpus(docScores);
      report[set].extractors[name] = {
        answerAccuracy: corpus.answerAccuracy,
        coverage: corpus.coverage,
        hallucinationRate: corpus.hallucinationRate,
        groundedness: corpus.groundedness,
        groundedChecked: corpus.groundedChecked,
        ece: corpus.calibration.ece,
        calibrationBuckets: corpus.calibration.buckets,
        counts: corpus.counts,
        perField: perField(docScores),
        failures: docScores.flatMap((d) => Object.entries(d.byField)
          .filter(([, c]) => !['hit', 'correct_abstention'].includes(c.outcome) || c.grounded === false)
          .map(([field, c]) => ({ item: d.item, field, ...c }))),
      };
    }
  }
  return report;
}

const fmt = (v) => (v === null || v === undefined ? ' null' : v.toFixed(3));

function print(report) {
  console.log('Floor on difficulty, not an estimate: Schedule III and Item 2 tables are easier than an OM.');
  for (const [set, r] of Object.entries(report)) {
    console.log(`\n=== ${set}: ${r.items} (filing, property) items x ${FIELD_NAMES.length} fields`);
    if (!r.extractors) { console.log(`  ${r.note}`); continue; }
    console.log('  extractor        accuracy coverage halluc.  grounded  ece    | hit err miss hall abst');
    for (const [name, m] of Object.entries(r.extractors)) {
      const c = m.counts;
      console.log(`  ${name.padEnd(16)} ${fmt(m.answerAccuracy)}    ${fmt(m.coverage)}    ${fmt(m.hallucinationRate)}    ${fmt(m.groundedness)}    ${fmt(m.ece)}  | `
        + `${c.hit} ${c.error} ${c.miss} ${c.hallucination} ${c.correct_abstention}`);
    }
    const tr = r.extractors.tableReader;
    if (tr) {
      console.log('\n  tableReader by field (hit/error/miss/hallucination/correct_abstention):');
      for (const [field, o] of Object.entries(tr.perField)) {
        console.log(`    ${field.padEnd(20)} ${['hit', 'error', 'miss', 'hallucination', 'correct_abstention'].map((k) => o[k] || 0).join(' / ')}`);
      }
      console.log('\n  tableReader failures:');
      for (const f of tr.failures) {
        console.log(`    ${f.outcome.padEnd(13)} ${f.field.padEnd(18)} got ${JSON.stringify(f.predicted)} want ${JSON.stringify(f.truth)}`
          + `${f.grounded === false ? ' [UNGROUNDED]' : ''}  ${f.item.split('#')[1]}`);
      }
    }
  }
}

try {
  const report = run();
  if (json) console.log(JSON.stringify(report, null, 2));
  else print(report);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
