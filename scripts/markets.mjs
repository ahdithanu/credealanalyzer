#!/usr/bin/env node
/**
 * Replace the market table's invented demographics with Census figures.
 *
 *   npm run markets                      # dry run: report what would change
 *   npm run markets -- --write           # write src/lib/marketsSourced.js
 *   npm run markets -- --only=columbus-oh
 *
 * Fills three of the nine fields on every market record — population, median
 * household income, and a five-year population CAGR — from ACS 5-year estimates
 * at CBSA level. Free, no key, nationwide.
 *
 * THE FIRST RUN IS A VERIFICATION RUN, and it has two jobs.
 *
 * api.census.gov is not reachable from the environment this was written in, so
 * no call here has ever been made. And the CBSA codes are from memory: a wrong
 * one does not fail, it answers with a real metro that is not yours. So the
 * report prints the name the Census returned beside the city the record claims
 * to be, and prints the old value beside the new one. Read both columns before
 * passing --write.
 *
 * What it will NOT fix: employment growth, supply pipeline, rent growth,
 * traffic counts and cap rates have no free source. Those stay seed data, and
 * because a record's dataQuality is its weakest field, every record stays
 * 'seed' after this runs. That is correct.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markets, fieldQuality } from '../src/lib/markets.js';
import {
  sourceMarket, CBSA, DEFAULT_VINTAGES, SOURCEABLE_FIELDS, renderSourcedModule,
} from '../src/lib/ingest/acsMarkets.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

const args = process.argv.slice(2);
const write = args.includes('--write');
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];

const targets = markets.filter((m) => !only || m.key === only);
if (!targets.length) {
  process.stderr.write(`no market matches --only=${only}\n`);
  process.exit(2);
}

const asOf = `ACS 5-year ${DEFAULT_VINTAGES.to}`;
const out = {};
let reached = 0;
let failed = 0;
let keyProblem = null;

process.stdout.write(
  `\n${C.bold('Sourcing')} ${C.dim(`${targets.length} markets from Census ACS `
    + `(${DEFAULT_VINTAGES.from} → ${DEFAULT_VINTAGES.to}, non-overlapping)`)}\n`
  + `${C.dim(`Fillable: ${SOURCEABLE_FIELDS.join(', ')}. `
    + 'The other six fields have no free source and stay seed data.')}\n\n`,
);

for (const market of targets) {
  const label = `${market.city}, ${market.state}`;
  let result;
  try {
    result = await sourceMarket(market.key, { cbsa: CBSA[market.key] });
  } catch (err) {
    failed += 1;
    process.stdout.write(`${C.bold(label.padEnd(22))} ${C.warn(`failed: ${err.message}`)}\n`);
    /**
     * A 403 is almost never the Census refusing you — it has no auth and no
     * rate limit that answers this way. It is the egress policy of wherever
     * this is running, and saying so saves an hour spent debugging a URL that
     * is correct.
     */
    if (err.code === 'missing_key' || err.code === 'invalid_key') {
      // Printed once, then the run is abandoned: thirty-six identical
      // failures scrolling past is not more informative than one.
      keyProblem = err.code;
      break;
    }
    if (err.status === 403) {
      process.stdout.write(`  ${C.dim('· 403 usually means api.census.gov is not on this '
        + 'environment\'s egress allowlist, not that the request was wrong.')}\n`);
    }
    continue;
  }

  /**
   * The name check, printed first because it is the one that catches the
   * failure this script cannot detect for itself. "Columbus, GA Metro Area"
   * against a record that says Columbus, OH is a transposed code, and the
   * population that came back with it is a real number about the wrong place.
   */
  const name = result.cbsaName || '(no name returned)';
  const plausible = result.cbsaName
    && result.cbsaName.toLowerCase().includes(market.city.toLowerCase())
    && result.cbsaName.toLowerCase().includes(market.state.toLowerCase());
  process.stdout.write(
    `${C.bold(label.padEnd(22))} ${C.dim(`CBSA ${result.cbsa || '—'}`)} `
    + `${plausible ? C.ok(name) : C.warn(`${name}  ← CHECK THIS CODE`)}\n`,
  );

  const changes = Object.entries(result.fields).filter(([k]) => k !== 'populationBasis');
  for (const [key, value] of changes) {
    const before = market[key];
    const delta = Number.isFinite(before) && before !== 0
      ? ` ${C.dim(`(${value > before ? '+' : ''}${(((value / before) - 1) * 100).toFixed(0)}%)`)}`
      : '';
    const fmt = (n) => (typeof n === 'number' ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(n));
    process.stdout.write(
      `  ${key.padEnd(16)} ${C.dim(`${fmt(before)} (${fieldQuality(market, key)})`)}`
      + `  →  ${C.ok(fmt(value))}${delta}\n`,
    );
  }
  if (result.fields.populationBasis && result.fields.populationBasis !== market.populationBasis) {
    process.stdout.write(
      `  ${C.warn('!')} population basis ${market.populationBasis} → ${result.fields.populationBasis}: `
      + `${C.dim('this record was a submarket carrying a city figure and now carries its metro\'s. '
        + 'Every submarket of one metro will score identically on Market Scale.')}\n`,
    );
  }
  for (const n of result.notes) process.stdout.write(`  ${C.dim(`· ${n}`)}\n`);

  if (changes.length) {
    reached += 1;
    out[market.key] = {
      cbsa: result.cbsa,
      cbsaName: result.cbsaName,
      asOf,
      fields: result.fields,
    };
  } else {
    failed += 1;
  }
  process.stdout.write('\n');
}

process.stdout.write(`${C.bold(`${reached} sourced`)}${failed ? C.warn(`, ${failed} not`) : ''}\n`);

if (keyProblem) {
  process.stdout.write(
    `\n${C.warn(keyProblem === 'missing_key'
      ? 'The Census needs an API key for this dataset.'
      : 'The Census rejected the API key in CENSUS_API_KEY.')}\n`
    + C.dim('  It answers a keyless request with an HTML page at HTTP 200, so this\n'
      + '  arrives looking like a call that returned no data rather than one that\n'
      + '  was refused.\n\n')
    + '  1. Sign up (free, instant): https://api.census.gov/data/key_signup.html\n'
    + `  2. ${C.bold('export CENSUS_API_KEY=your-key')}\n`
    + '  3. Re-run. Keep the key out of the repo; it is read from the environment\n'
    + '     and masked in every message this prints.\n\n',
  );
  process.exit(2);
}

/**
 * Nothing was sourced, so there is nothing to write.
 *
 * This used to write regardless. On a run where every market failed it
 * rendered an overlay of `{}` over whatever was on disk and exited 0 — so a
 * key that expired, or a Census outage, would silently delete thirty-six
 * sourced records and report success. The file being empty when the bug
 * shipped is the only reason it cost nothing.
 */
if (!reached) {
  process.stdout.write(C.warn('\nNothing sourced, so nothing written.\n')
    + C.dim('  The overlay on disk is left exactly as it was.\n\n'));
  process.exit(1);
}

if (!write) {
  process.stdout.write(C.dim('\nDry run. Check the CBSA names above, then re-run with --write.\n\n'));
  process.exit(0);
}

// Merge into what is on disk rather than replacing it. A --only run touches
// one market and must not drop the other thirty-five; a full run that reached
// only some of them must not drop the ones it could not reach this time.
const { SOURCED: existing } = await import('../src/lib/marketsSourced.js');
const merged = { ...existing, ...out };

const lost = Object.keys(existing).filter((k) => !(k in merged));
if (lost.length) {
  // Unreachable with a spread merge, and asserted rather than assumed: this
  // is the invariant the bug above violated, and it is cheap to keep checking.
  process.stdout.write(C.warn(`\nRefusing to write: would drop ${lost.join(', ')}.\n\n`));
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../src/lib/marketsSourced.js');
writeFileSync(target, renderSourcedModule(merged, { vintages: DEFAULT_VINTAGES }));
process.stdout.write(C.dim(`\n→ ${target}\n`)
  + C.dim(`  ${Object.keys(merged).length} markets in the overlay.\n`)
  + C.dim('  Now run the suite: the markets test asserts nothing claims to be\n'
    + '  sourced, and it is meant to fail the first time this succeeds.\n\n'));
