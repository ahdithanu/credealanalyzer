#!/usr/bin/env node
/**
 * Fetch public SEC filings into the extraction eval corpus.
 *
 *   npm run edgar -- --cik=899689 --limit=3
 *   npm run edgar -- --cik=899689 --forms=10-K,8-K --limit=5
 *   npm run edgar -- --cik=899689 --out=corpus/edgar
 *
 * Downloads the primary document of each matching filing and writes a
 * manifest beside them. Every entry starts with `groundTruth: null` — fetching
 * is not labelling, and src/extraction/edgar.js refuses to score a corpus
 * where the two have been confused.
 *
 * Why filings and not offering memoranda: see the header of
 * src/extraction/edgar.js, and docs/extraction-eval.md for what this corpus
 * can and cannot tell you.
 *
 * SEC asks automated clients to identify themselves and to stay under ten
 * requests a second. Both are honoured. To send your own contact details
 * instead of the default client name, set EDGAR_USER_AGENT yourself.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  submissionsUrl, filingUrl, selectFilings, manifestEntry,
  DEFAULT_USER_AGENT, MIN_REQUEST_INTERVAL_MS, padCik,
} from '../src/extraction/edgar.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const cik = flag('cik');
const limit = Number(flag('limit', '3'));
const forms = flag('forms', '10-K').split(',').map((s) => s.trim()).filter(Boolean);
const outDir = resolve(ROOT, flag('out', 'corpus/edgar'));
const userAgent = process.env.EDGAR_USER_AGENT || DEFAULT_USER_AGENT;

if (!cik) {
  console.error('usage: npm run edgar -- --cik=<CIK> [--forms=10-K] [--limit=3] [--out=corpus/edgar]');
  process.exit(2);
}

let lastRequest = 0;
async function get(url, { json = false } = {}) {
  // Throttle in the client rather than trusting that the loop is slow enough.
  const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();

  const res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: '*/*' } });
  if (!res.ok) {
    // Say which URL and which status. A corpus fetch that half-works and
    // reports nothing is how an eval ends up measured over four documents
    // while its author believes it ran over ten.
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return json ? res.json() : res.text();
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');

  // Resume rather than refetch: filings are immutable once filed, so anything
  // already on disk is still correct, and re-downloading it only spends
  // somebody else's rate limit.
  const existing = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : [];
  const have = new Set(existing.map((e) => e.id));

  console.log(`fetching submissions for CIK ${padCik(cik)} as "${userAgent}"`);
  const submissions = await get(submissionsUrl(cik), { json: true });
  const company = submissions.name || null;

  const filings = selectFilings(submissions, { forms, limit });
  if (!filings.length) {
    console.error(`no ${forms.join('/')} filings found for ${company || cik}`);
    process.exit(1);
  }
  console.log(`${company || cik}: ${filings.length} filing(s)`);

  const added = [];
  for (const filing of filings) {
    const entry = manifestEntry({ cik, company, filing, localPath: null, fetchedAt: null });
    if (have.has(entry.id)) {
      console.log(`  skip  ${entry.id} (already fetched)`);
      continue;
    }
    const url = filingUrl({ cik, accessionNumber: filing.accessionNumber, document: filing.document });
    const name = `${entry.id}-${filing.document}`;
    const path = join(outDir, name);

    process.stdout.write(`  get   ${filing.form} ${filing.reportDate} ... `);
    const body = await get(url);
    await writeFile(path, body, 'utf8');
    console.log(`${(body.length / 1024).toFixed(0)}kB`);

    added.push({ ...entry, localPath: name, fetchedAt: new Date().toISOString() });
  }

  const manifest = [...existing, ...added];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`\n${added.length} new, ${manifest.length} total -> ${manifestPath}`);
  console.log(`${manifest.filter((e) => e.groundTruth === null).length} still unlabelled.`);
  console.log('Labelling guide: docs/extraction-eval.md');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
