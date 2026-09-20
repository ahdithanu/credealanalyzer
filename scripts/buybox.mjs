#!/usr/bin/env node
/**
 * Screen a list of deals against a buy box.
 *
 *   npm run buybox -- deals.json
 *   npm run buybox -- deals.json --box=small-multifamily
 *   npm run buybox -- deals.json --verbose        # every criterion, not just failures
 *
 * The input is a JSON array of deal records. Everything is optional except a
 * name — a record with three fields gets a verdict of `incomplete` and a list
 * of what to go and find out, which is the intended way to use this at the top
 * of a funnel. See docs/buy-box.md for the field list and a worked example.
 *
 * Exists so a broker's list can be screened before any of it is keyed into the
 * app. The app is where a deal gets underwritten; this is where it earns the
 * right to be.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rank, BUY_BOXES, STRIP_CENTER_BOX } from '../src/lib/buyBox.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const boxKey = (args.find((a) => a.startsWith('--box=')) || '').slice(6) || STRIP_CENTER_BOX.key;
const verbose = args.includes('--verbose');

if (!file) {
  process.stderr.write(
    'usage: npm run buybox -- <deals.json> [--box=strip-center|small-multifamily] [--verbose]\n'
    + `boxes: ${Object.keys(BUY_BOXES).join(', ')}\n`,
  );
  process.exit(2);
}
if (!BUY_BOXES[boxKey]) {
  process.stderr.write(`unknown box ${boxKey}; try ${Object.keys(BUY_BOXES).join(' or ')}\n`);
  process.exit(2);
}

let deals;
try {
  deals = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
} catch (err) {
  process.stderr.write(`could not read ${file}: ${err.message}\n`);
  process.exit(2);
}
if (!Array.isArray(deals)) {
  process.stderr.write('expected a JSON array of deal records\n');
  process.exit(2);
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  pass: (s) => `\x1b[32m${s}\x1b[0m`,
  fail: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  info: (s) => `\x1b[36m${s}\x1b[0m`,
};

const VERDICT = {
  pass:       { label: 'PASS      ', paint: C.pass },
  review:     { label: 'REVIEW    ', paint: C.warn },
  incomplete: { label: 'INCOMPLETE', paint: C.info },
  fail:       { label: 'FAIL      ', paint: C.fail },
};

const ranked = rank(deals, boxKey);
const box = BUY_BOXES[boxKey];

process.stdout.write(`\n${C.bold(box.name)}  ${C.dim(`— ${deals.length} candidates`)}\n\n`);

for (const r of ranked) {
  const v = VERDICT[r.verdict];
  const name = r.deal.name || r.deal.id || '(unnamed)';
  process.stdout.write(
    `${v.paint(v.label)}  ${C.bold(name.padEnd(28))}`
    + C.dim(`${r.passed} of ${r.passed + r.failed + r.unknown} criteria met\n`),
  );

  // Failures always. They are the reason the verdict is what it is.
  for (const c of r.results.filter((x) => x.status === 'fail')) {
    const tag = c.severity === 'hard' ? C.fail('  ✗') : C.warn('  ~');
    process.stdout.write(`${tag} ${c.label}: ${c.display} ${C.dim(`(want ${c.threshold})`)}\n`);
  }

  // What to go and find out. The point of `incomplete` being its own verdict is
  // that it comes with a shopping list rather than a rejection.
  if (r.unknown) {
    const names = r.results.filter((x) => x.status === 'unknown').map((x) => x.label);
    process.stdout.write(`${C.info('  ?')} not measured: ${C.dim(names.join(', '))}\n`);
  }

  if (verbose) {
    for (const c of r.results.filter((x) => x.status === 'pass')) {
      process.stdout.write(`${C.pass('  ✓')} ${C.dim(`${c.label}: ${c.display}`)}\n`);
    }
  }

  // Rollover is not a criterion and is the thing most likely to change a mind
  // about a centre that passes everything, so it is printed beside the verdict.
  const roll = r.measured.rolloverByYear;
  if (roll) {
    const soon = roll[0].shareOfRentPct + roll[1].shareOfRentPct;
    if (soon >= 30) {
      process.stdout.write(
        `${C.warn('  !')} ${soon.toFixed(0)}% of rent expires within 24 months `
        + C.dim('(WALT is an average and does not show this)\n'),
      );
    }
  }
  process.stdout.write('\n');
}

const tally = ranked.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] || 0) + 1 }), {});
process.stdout.write(C.dim(
  `${tally.pass || 0} pass · ${tally.review || 0} review · `
  + `${tally.incomplete || 0} incomplete · ${tally.fail || 0} fail\n\n`,
));

void HERE;
