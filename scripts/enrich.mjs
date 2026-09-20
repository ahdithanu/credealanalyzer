#!/usr/bin/env node
/**
 * Fill in the site criteria from free public data.
 *
 *   npm run enrich -- deals.json            # writes deals.enriched.json
 *   npm run enrich -- deals.json --write    # updates deals.json in place
 *   npm run enrich -- --probe=OH            # check a DOT endpoint before trusting it
 *
 * Each deal needs an `address`, `city` and `state`. What comes back:
 *
 *   trafficCount    nearest state DOT count station, with its distance and year
 *   pop3mi          ACS population in tracts whose centroid is inside 3 miles
 *   popGrowth3mi    COUNTY-level 5-year growth — see the note it prints
 *
 * THE FIRST RUN IS A VERIFICATION RUN. None of these endpoints has ever been
 * called from where this was written, and state DOT service URLs move. Probe
 * your state first; the traffic numbers are a guess until you do.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { enrichDemographics } from '../src/lib/ingest/census.js';
import { trafficNear, probe, DOT_SOURCES } from '../src/lib/ingest/dot.js';
import { mergeListing } from '../src/lib/ingest/listing.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  info: (s) => `\x1b[36m${s}\x1b[0m`,
};

const args = process.argv.slice(2);
const probeArg = args.find((a) => a.startsWith('--probe'));
const file = args.find((a) => !a.startsWith('--'));
const write = args.includes('--write');

// ── Probe mode ─────────────────────────────────────────────────────────────
if (probeArg) {
  const state = (probeArg.split('=')[1] || '').toUpperCase();
  if (!state) {
    process.stderr.write(`usage: --probe=OH   known: ${Object.keys(DOT_SOURCES).join(', ')}\n`);
    process.exit(2);
  }
  try {
    const r = await probe(state);
    process.stdout.write(`\n${C.bold(r.name)}\n${C.dim(r.url)}\n\n`);
    process.stdout.write(`  fields: ${r.fieldNames.slice(0, 20).join(', ')}\n`);
    process.stdout.write(`  AADT field: ${r.aadtFieldFound
      ? C.ok(r.aadtFieldFound)
      : C.warn('NOT FOUND — add the right name to aadtFields in src/lib/ingest/dot.js')}\n`);
    process.stdout.write(`  year field: ${r.yearFieldFound || C.dim('none')}\n\n`);
    if (r.aadtFieldFound) {
      process.stdout.write(C.ok('  This endpoint works. Set verified: true for it.\n\n'));
    }
  } catch (err) {
    process.stdout.write(`\n${C.warn(`probe failed: ${err.message}`)}\n\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (!file) {
  process.stderr.write('usage: npm run enrich -- <deals.json> [--write]\n'
    + '       npm run enrich -- --probe=OH\n');
  process.exit(2);
}

let deals;
try {
  deals = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
} catch (err) {
  process.stderr.write(`could not read ${file}: ${err.message}\n`);
  process.exit(2);
}

process.stdout.write(`\n${C.bold('Enriching')} ${C.dim(`${deals.length} deals from public data`)}\n`);

for (const deal of deals) {
  const address = [deal.address, deal.city, deal.state].filter(Boolean).join(', ');
  process.stdout.write(`\n${C.bold(deal.name || address || '(unnamed)')}\n`);
  if (!deal.address || !deal.city || !deal.state) {
    process.stdout.write(`  ${C.warn('!')} needs address, city and state to enrich\n`);
    continue;
  }

  const sources = [];
  const notes = [];

  // Demographics, which also geocodes and gives the point the DOT query needs.
  let point = null;
  try {
    const demo = await enrichDemographics(address);
    point = demo.point || null;
    notes.push(...(demo.notes || []));
    if (Object.keys(demo.fields).length) {
      sources.push({
        sourceKind: 'public',
        sourceName: `Census ACS ${demo.detail?.latestVintage ?? ''}`.trim(),
        fields: demo.fields,
      });
      if (demo.fields.pop3mi != null) {
        process.stdout.write(`  ${C.ok('+')} pop3mi        ${demo.fields.pop3mi.toLocaleString()}`
          + C.dim(`  (${demo.detail.tractCount} tracts, ${demo.detail.tractMethod})\n`));
      }
      if (demo.fields.popGrowth3mi != null) {
        const g = demo.fields.popGrowth3mi;
        process.stdout.write(`  ${C.ok('+')} popGrowth     ${g > 0 ? '+' : ''}${g.toFixed(1)}%`
          + C.dim(`  (${demo.detail.countyName} — county proxy)\n`));
      }
    }
  } catch (err) {
    notes.push(`Census: ${err.message}`);
  }

  // Traffic, which needs the geocoded point.
  if (point) {
    try {
      const traffic = await trafficNear(point, deal.state);
      notes.push(...(traffic.notes || []));
      if (traffic.fields.trafficCount != null) {
        sources.push({
          sourceKind: 'public',
          sourceName: `${DOT_SOURCES[deal.state.toUpperCase()]?.name || 'state DOT'}`
            + `${traffic.detail?.year ? ` ${traffic.detail.year}` : ''}`,
          fields: { trafficCount: traffic.fields.trafficCount },
        });
        process.stdout.write(`  ${C.ok('+')} trafficCount  `
          + `${traffic.fields.trafficCount.toLocaleString()}`
          + C.dim(`  (${traffic.detail.miles.toFixed(2)} mi away, field ${traffic.detail.field})\n`));
      }
    } catch (err) {
      notes.push(`DOT: ${err.message}`);
    }
  }

  /**
   * Merge the deal's existing values with what came back, and REPORT the
   * disagreements rather than overwriting silently.
   *
   * This is the point of the exercise. A flyer claiming 25,000 vehicles per day
   * against a DOT-measured 16,400 is a 34% overstatement that moves the deal
   * from inside your traffic criterion to outside it, and the enrichment's job
   * is to put both numbers in front of you — not to quietly win.
   */
  const existing = {};
  for (const k of ['trafficCount', 'popGrowth3mi', 'pop3mi']) {
    if (deal[k] !== undefined && deal[k] !== null) existing[k] = deal[k];
  }
  const merged = mergeListing([
    ...(Object.keys(existing).length
      ? [{ sourceKind: 'marketing', sourceName: 'listing/flyer as supplied', fields: existing }]
      : []),
    ...sources,
  ]);

  for (const c of merged.conflicts) {
    const d = c.dissenting[0];
    process.stdout.write(
      `  ${C.warn('!')} ${c.field}: ${C.bold(String(c.leading.value))} `
      + `${C.dim(`(${c.leading.source})`)} vs ${d.value} ${C.dim(`(${d.source})`)}`
      + `${c.spreadPct ? C.warn(` — ${c.spreadPct.toFixed(0)}% spread`) : ''}\n`,
    );
  }

  Object.assign(deal, merged.fields);
  deal.provenance = { ...(deal.provenance || {}), ...merged.provenance };

  for (const n of notes) process.stdout.write(`  ${C.dim(`· ${n}`)}\n`);
}

const out = write ? file : file.replace(/\.json$/, '.enriched.json');
writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(deals, null, 2)}\n`);
process.stdout.write(`\n${C.dim(`→ ${out}`)}\n`);
process.stdout.write(C.dim('  Now screen it:  npm run buybox -- '
  + `${out}\n\n`));
