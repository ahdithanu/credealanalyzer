/**
 * The buy box, applied to the deals already in the pipeline.
 *
 * `buyBox.js` screens a SCREENING record — the shape `scripts/buybox.mjs` reads
 * out of a broker's JSON. The app's deal record is a different object with some
 * of the same field names, and this module is the adapter between them. It
 * exists because two of those shared names mean different things in the two
 * places, and bridging them naively produces a verdict that is confidently
 * wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY REFUSES TO BRIDGE
 *
 * `vacancyRate`. In a screening record it is what the rent roll shows today. In
 * an app deal it is an UNDERWRITING ASSUMPTION: `blankDeal()` seeds it from the
 * firm's house default for the property type and the engine applies it across
 * the whole hold. On a ground-up deal it describes a building that does not
 * exist yet.
 *
 * Passing it through would report "Occupancy 95% ✓" for a centre nobody has
 * walked, off a number the analyst never claimed as a measurement — a pass
 * manufactured out of a default. So it is dropped, occupancy reads `unknown`
 * until a rent roll is keyed in, and the screen says why rather than leaving
 * the reader to wonder where their 7% went.
 *
 * `0`. The app initialises price, size and unit count to zero, so a deal the
 * analyst has opened but not filled in carries three zeros. A $0 price is not a
 * price below the floor, it is no price, and grading it `fail` would rule out
 * every deal at the moment it is created. Zero is read as absent for the fields
 * where zero is not a possible measurement — and only those. `popGrowth3mi` is
 * NOT in that list: a flat 3-mile population is a real reading and the
 * criterion that tests it is the one you would most regret silencing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { evaluate, STRIP_CENTER_BOX, SMALL_MULTIFAMILY_BOX } from './buyBox.js';

/**
 * Which box a property type is screened against.
 *
 * A type with no entry is not screened at all, and the pipeline shows an
 * absence for it. The alternative — screening a car wash against the strip
 * centre criteria — would grade it on bay count and restaurant share, and a row
 * of red against rules that were never meant to apply to it teaches the reader
 * to ignore the column.
 */
export const BOX_BY_PROPERTY_TYPE = {
  retail: STRIP_CENTER_BOX.key,
  multifamily: SMALL_MULTIFAMILY_BOX.key,
};

/** Fields where a zero is the app's "not filled in", not a measurement. */
export const ZERO_MEANS_UNSET = [
  'purchasePrice', 'buildingSize', 'units', 'yearBuilt',
  'bayCount', 'trafficCount', 'parkingSpaces',
];

export const OCCUPANCY_NOTE =
  'Occupancy is unmeasured. This deal\'s vacancy rate is an underwriting assumption — '
  + 'seeded from the firm defaults and applied across the hold — not a count of what is '
  + 'occupied today, so it is not read as occupancy. Key in a rent roll to measure it.';

export const BUY_BOX_FOOTNOTE =
  'Buy box: In box = every criterion measured and met · Review = a soft criterion missed · '
  + 'Incomplete = something material was never measured · Outside = a hard criterion missed. '
  + 'Incomplete is not a near miss — it is a deal that has not taken the test.';

/** Display and sort order for each verdict. Rank orders the column. */
export const VERDICT = {
  pass: { label: 'In box', tone: 'pos', rank: 0 },
  review: { label: 'Review', tone: 'warn', rank: 1 },
  incomplete: { label: 'Incomplete', tone: '', rank: 2 },
  fail: { label: 'Outside', tone: 'neg', rank: 3 },
};

/** A deal no box applies to sorts below every screened one, in either direction. */
export const UNSCREENED_RANK = 9;

function finite(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The buy box for a deal's property type, or null when none applies. */
export function boxForDeal(deal) {
  if (!deal) return null;
  return BOX_BY_PROPERTY_TYPE[deal.propertyType] ?? null;
}

/**
 * An app deal as a screening record.
 *
 * Only ever fed to `evaluate`. It is lossy on purpose — see the header — so it
 * is not a general-purpose conversion and nothing else should reach for it.
 */
export function adaptDeal(deal = {}) {
  const out = { ...deal };
  for (const key of ZERO_MEANS_UNSET) {
    if (finite(out[key]) === 0) delete out[key];
  }
  delete out.vacancyRate;
  return out;
}

/**
 * Screen one pipeline deal.
 *
 * @returns the `evaluate` result plus `notes`, or `null` when no box applies to
 *          this property type. Null is the honest answer and is rendered as an
 *          absence; a verdict would be a claim about criteria nobody wrote for
 *          this asset class.
 */
export function screenDeal(deal, opts = {}) {
  const boxKey = boxForDeal(deal);
  if (!boxKey) return null;

  const result = evaluate(adaptDeal(deal), boxKey, opts);

  // A note explains an absence the reader can see a value for elsewhere in the
  // app. Without this the occupancy row reads `n/a` on a deal whose Deal Model
  // screen plainly shows a vacancy rate, which looks like a bug rather than a
  // refusal.
  const notes = [];
  const gradesOccupancy = result.results.some((r) => r.key === 'occupancyPct');
  const hasRentRoll = Array.isArray(deal?.rentRoll) && deal.rentRoll.length > 0;
  if (gradesOccupancy && !hasRentRoll && finite(deal?.vacancyRate) !== null) {
    notes.push(OCCUPANCY_NOTE);
  }

  return { ...result, notes };
}

/** Sort key for the pipeline's buy box column. */
export function verdictRank(screen) {
  if (!screen) return UNSCREENED_RANK;
  return VERDICT[screen.verdict]?.rank ?? UNSCREENED_RANK;
}
