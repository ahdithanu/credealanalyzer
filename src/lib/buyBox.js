/**
 * The buy box — a written list of criteria turned into something the tool
 * enforces.
 *
 * A buy box that lives in a document is a buy box you argue yourself out of at
 * 11pm on a deal you like. This module holds the criteria as data, tests a
 * candidate against every one of them, and returns a per-criterion verdict with
 * the measured value beside the threshold. The point is not the pass/fail; it
 * is that the failure says WHICH rule and BY HOW MUCH, so the decision to
 * override is made explicitly and once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE VERDICTS, NOT TWO
 *
 *   'pass'     measured, inside the criterion
 *   'fail'     measured, outside it
 *   'unknown'  not measured — the candidate does not carry the input
 *
 * The third is the one that matters and the one a boolean filter destroys. A
 * centre whose rent roll nobody has keyed in has not passed the tenant
 * concentration test; it has not taken it. Scoring that as a pass fills a
 * shortlist with deals whose worst feature is the one nobody looked at, and
 * scoring it as a fail throws away every deal at the top of the funnel, which
 * is all of them. So `unknown` is reported as itself, it is counted separately,
 * and `verdict` is never 'pass' while anything material is unknown.
 *
 * `severity` separates the criteria that end a conversation from the ones that
 * start a negotiation. Price is a 'hard' rule: outside the range, it is not
 * your deal. Tenant mix is 'soft': a centre at 28% restaurants is a different
 * object from one at 60%, and collapsing both to 'fail' loses that.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Explicit extension, unlike the rest of src/lib, so this module and its
// dependency can be imported by plain Node as well as by Vite — which is what
// lets scripts/buybox.mjs screen a broker's list without a build step. Vite
// resolves an explicit extension identically.
import { analyseRentRoll } from './rentRoll.js';

/** Finite number, or null. */
function finite(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const pct = (n) => (n === null ? null : `${n.toFixed(1)}%`);
const money = (n) => (n === null ? null : `$${Math.round(n).toLocaleString()}`);
const psf = (n) => (n === null ? null : `$${n.toFixed(2)}/SF`);
const yrs = (n) => (n === null ? null : `${n.toFixed(1)} yr`);

/**
 * A criterion.
 *
 * `measure` returns the number (or null when unmeasurable); `test` decides.
 * They are separate so the report can show the measured value on a failure,
 * which is the only part anyone reads.
 */
function range(key, label, { min = null, max = null, severity = 'hard', format = String, note }) {
  return {
    key,
    label,
    severity,
    note,
    threshold: [
      min === null ? null : `at least ${format(min)}`,
      max === null ? null : `at most ${format(max)}`,
    ].filter(Boolean).join(', '),
    test(value) {
      if (value === null) return 'unknown';
      if (min !== null && value < min) return 'fail';
      if (max !== null && value > max) return 'fail';
      return 'pass';
    },
    format,
  };
}

/**
 * The small-bay neighbourhood strip centre box.
 *
 * Every threshold here is the operator's, not a house view. They are collected
 * in one place so changing one is a deliberate edit rather than a number
 * adjusted inside a condition.
 */
export const STRIP_CENTER_BOX = {
  key: 'strip-center',
  name: 'Small-bay neighbourhood strip centre',
  propertyType: 'retail',
  criteria: [
    range('buildingSize', 'Building size', {
      min: 8000, max: 25000, format: (n) => `${n.toLocaleString()} SF`,
    }),
    range('bayCount', 'Bay count', {
      min: 5, max: 12, format: (n) => `${n} bays`,
      note: 'Enough tenants that one vacancy does not break the deal; small enough that '
        + 'institutions ignore it.',
    }),
    range('avgBaySF', 'Average bay size', {
      min: 1200, max: 2500, severity: 'soft', format: (n) => `${n.toLocaleString()} SF`,
    }),
    range('price', 'Purchase price', {
      min: 1_500_000, max: 4_000_000, format: money,
    }),
    range('pricePSF', 'Price per SF', {
      min: 100, max: 200, format: (n) => `$${n}/SF`,
      note: 'Checked independently of total price: the two ranges do not line up at the '
        + 'corners. 25,000 SF at $200/SF is $5M, past the price cap; 8,000 SF at $100/SF '
        + 'is $800k, under the floor.',
    }),
    range('yearBuilt', 'Vintage', {
      min: 1985, format: (n) => String(n),
      note: 'Roof, HVAC and parking lot are the capex landmines. Get remaining useful '
        + 'life on all three before the LOI, not after.',
    }),
    range('occupancyPct', 'Occupancy', {
      min: 80, max: 100, format: pct,
      note: 'One or two vacant bays is the value-add. Note this interacts with bay count: '
        + 'at 5 bays, two vacant is 40% and breaks this floor.',
    }),
    range('largestTenantShare', 'Largest tenant share of rent', {
      max: 30, format: pct,
      note: 'The retail version of "do not buy a 4-unit". Grouped by operator, so three '
        + 'bays held by one tenant count once.',
    }),
    range('restaurantSharePct', 'Restaurant share of rent', {
      max: 25, severity: 'soft', format: pct,
      note: 'Turnover, grease traps, and a buildout the landlord eats on exit.',
    }),
    range('waltYears', 'Weighted average lease term', {
      min: 3, format: yrs,
      note: 'Weighted by rent, not area.',
    }),
    range('rentVsMarketPct', 'In-place rent vs market', {
      max: 0, severity: 'soft', format: (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`,
      note: 'At or below market. Above-market rent looks like income in the OM and '
        + 'resets down at renewal.',
    }),
    range('trafficCount', 'Traffic count', {
      min: 15000, format: (n) => `${n.toLocaleString()} VPD`,
    }),
    range('parkingPer1000SF', 'Parking ratio', {
      min: 4, format: (n) => `${n.toFixed(1)} per 1,000 SF`,
    }),
    range('popGrowth3mi', '3-mile population growth', {
      min: 0, severity: 'soft', format: (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`,
      note: 'Growing or at least stable. Negative is the one to walk from.',
    }),
  ],
};

/**
 * The small multifamily box.
 *
 * Kept deliberately short. It is a different asset class with different
 * diligence, and padding it with retail-shaped criteria would imply this tool
 * checks things for multifamily that it does not.
 */
export const SMALL_MULTIFAMILY_BOX = {
  key: 'small-multifamily',
  name: 'Small multifamily',
  propertyType: 'multifamily',
  criteria: [
    range('units', 'Unit count', { min: 16, max: 32, format: (n) => `${n} units` }),
    range('price', 'Purchase price', { min: 1_000_000, max: 3_000_000, format: money }),
    range('pricePerUnit', 'Price per unit', {
      min: null, max: null, severity: 'soft', format: money,
      note: 'Reported, not gated: the unit and price ranges already imply $31k–$188k per '
        + 'door, and a second threshold on the same two numbers would not add a test.',
    }),
    range('yearBuilt', 'Vintage', { min: 1980, format: (n) => String(n) }),
    range('occupancyPct', 'Occupancy', { min: 80, max: 100, severity: 'soft', format: pct }),
  ],
};

export const BUY_BOXES = {
  [STRIP_CENTER_BOX.key]: STRIP_CENTER_BOX,
  [SMALL_MULTIFAMILY_BOX.key]: SMALL_MULTIFAMILY_BOX,
};

/**
 * Pull every measurable figure out of a deal, deriving what can be derived.
 *
 * Kept separate from the testing so the measurement is inspectable: a caller
 * that disagrees with a verdict can see the number it was reached from.
 */
export function measure(deal = {}, { asOf } = {}) {
  const roll = Array.isArray(deal.rentRoll) && deal.rentRoll.length
    ? analyseRentRoll(deal.rentRoll, { asOf })
    : null;

  // The rent roll wins where it disagrees with the header figures. A keyed roll
  // is the primary document; `buildingSize` on the deal record is somebody's
  // summary of it, and when they differ the summary is the one that is wrong.
  const buildingSize = roll?.totalSF ?? finite(deal.buildingSize);
  const price = finite(deal.purchasePrice);
  const units = finite(deal.units);

  return {
    buildingSize,
    bayCount: roll?.bayCount ?? finite(deal.bayCount),
    avgBaySF: roll?.bayCount ? (roll.totalSF === null ? null : roll.totalSF / roll.bayCount) : null,
    price,
    pricePSF: price !== null && buildingSize ? price / buildingSize : null,
    pricePerUnit: price !== null && units ? price / units : null,
    units,
    yearBuilt: finite(deal.yearBuilt),
    occupancyPct: roll?.occupancyPct
      ?? (finite(deal.vacancyRate) === null ? null : 100 - finite(deal.vacancyRate)),
    largestTenantShare: roll?.largestTenantShare ?? null,
    restaurantSharePct: roll?.restaurantSharePct ?? null,
    waltYears: roll?.waltYears ?? null,
    rentVsMarketPct: roll?.rentVsMarketPct ?? null,
    trafficCount: finite(deal.trafficCount),
    parkingPer1000SF: finite(deal.parkingSpaces) !== null && buildingSize
      ? (finite(deal.parkingSpaces) / buildingSize) * 1000
      : null,
    popGrowth3mi: finite(deal.popGrowth3mi),
    // Carried through for the report, not tested: they are context a reader
    // wants next to the verdict.
    anchorStatus: deal.anchorStatus ?? null,
    inPlaceRentPSF: roll?.inPlaceRentPSF ?? null,
    nnnShareOfRentPct: roll?.nnnShareOfRentPct ?? null,
    rolloverByYear: roll?.rolloverByYear ?? null,
    amazonResistantSharePct: roll?.amazonResistantSharePct ?? null,
  };
}

/**
 * Test a deal against a buy box.
 *
 * @returns {{
 *   box: string, verdict: 'pass'|'review'|'fail'|'incomplete',
 *   results: Array, passed: number, failed: number, unknown: number,
 *   hardFailures: Array, measured: object
 * }}
 */
export function evaluate(deal, boxKey = STRIP_CENTER_BOX.key, { asOf } = {}) {
  const box = BUY_BOXES[boxKey];
  if (!box) throw new Error(`unknown buy box: ${boxKey}`);

  const measured = measure(deal, { asOf });

  const results = box.criteria.map((c) => {
    const value = measured[c.key] ?? null;
    // A criterion with no bounds is reported, never tested — see the note on
    // pricePerUnit. Testing it would always pass and pad the score.
    const status = c.threshold === '' ? 'reported' : c.test(value);
    return {
      key: c.key,
      label: c.label,
      severity: c.severity,
      status,
      value,
      display: value === null ? null : c.format(value),
      threshold: c.threshold,
      note: c.note,
    };
  });

  const graded = results.filter((r) => r.status !== 'reported');
  const passed = graded.filter((r) => r.status === 'pass').length;
  const failed = graded.filter((r) => r.status === 'fail').length;
  const unknown = graded.filter((r) => r.status === 'unknown').length;
  const hardFailures = graded.filter((r) => r.status === 'fail' && r.severity === 'hard');

  /**
   * The verdict, in the order the cases actually matter.
   *
   * A hard failure outranks everything: a centre outside the price range does
   * not become interesting because the rent roll is immaculate. Incompleteness
   * outranks a pass, because a deal cannot pass a test it has not taken —
   * this is the whole reason 'unknown' exists as a third state.
   */
  let verdict;
  if (hardFailures.length) verdict = 'fail';
  else if (unknown > 0) verdict = 'incomplete';
  else if (failed > 0) verdict = 'review';
  else verdict = 'pass';

  return {
    box: box.key,
    boxName: box.name,
    verdict,
    passed,
    failed,
    unknown,
    hardFailures,
    results,
    measured,
    /** What to key in next, highest-leverage first: the hard rules nobody measured. */
    missing: graded
      .filter((r) => r.status === 'unknown')
      .sort((a, b) => (a.severity === 'hard' ? -1 : 1) - (b.severity === 'hard' ? -1 : 1))
      .map((r) => r.key),
  };
}

/**
 * Rank a list of deals against a box.
 *
 * Sorted by verdict first and then by how many criteria a deal actually clears,
 * so an incomplete deal that passes eight tests outranks an incomplete deal
 * that passes two — the shortlist orders by what is known, and the `missing`
 * list on each row says what to go and find out.
 */
export function rank(deals = [], boxKey = STRIP_CENTER_BOX.key, opts = {}) {
  const ORDER = { pass: 0, review: 1, incomplete: 2, fail: 3 };
  return deals
    .map((d) => ({ deal: d, ...evaluate(d, boxKey, opts) }))
    .sort((a, b) => (ORDER[a.verdict] - ORDER[b.verdict])
      || (b.passed - a.passed)
      || (a.failed - b.failed));
}
