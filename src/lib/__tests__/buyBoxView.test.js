/**
 * The adapter between the app's deal record and the buy box's screening record.
 *
 * Every assertion here guards a way of producing a confident verdict from
 * something that was never a measurement. That is the only interesting failure
 * mode of this layer: the box itself is tested in buyBox.test.js, and a wrong
 * threshold is visible on the screen. A pass manufactured out of a firm default
 * is not visible anywhere — it looks exactly like a pass.
 */

import {
  screenDeal, adaptDeal, boxForDeal, verdictRank,
  VERDICT, UNSCREENED_RANK, ZERO_MEANS_UNSET, OCCUPANCY_NOTE,
} from '../buyBoxView';
import { blankDeal } from '../../App';

const criterion = (screen, key) => screen.results.find((r) => r.key === key);

const retail = (over = {}) => ({ propertyType: 'retail', ...over });
const multifamily = (over = {}) => ({ propertyType: 'multifamily', ...over });

/** A let centre: 8,000 SF leased of 10,000 SF, so 80% by area. */
const LET_ROLL = [
  {
    tenant: 'Valley Dental',
    category: 'medical',
    squareFeet: 8000,
    baseRentAnnual: 160000,
    leaseEnd: '2032-01-01',
    recovery: 'nnn',
  },
  { vacant: true, category: 'vacant', squareFeet: 2000 },
];

describe('an underwriting assumption is never read as a measurement', () => {
  it('a deal\'s vacancy rate does not become its occupancy', () => {
    // 5% vacancy is what the firm assumes for this property type over the
    // hold. Read as occupancy it is 95%, comfortably inside the 80–100% floor,
    // and the centre passes a test nobody performed on it.
    const screen = screenDeal(retail({ vacancyRate: 5 }));

    const occupancy = criterion(screen, 'occupancyPct');
    expect(occupancy.status).toBe('unknown');
    expect(occupancy.value).toBeNull();
    expect(screen.verdict).not.toBe('pass');
  });

  it('says why occupancy is unmeasured, because the app shows a vacancy rate elsewhere', () => {
    // Without this the row reads `n/a` on a deal whose Deal Model screen
    // plainly carries a vacancy rate — which looks like a defect rather than a
    // refusal, and gets "fixed" by wiring the two together.
    const screen = screenDeal(retail({ vacancyRate: 5 }));
    expect(screen.notes).toContain(OCCUPANCY_NOTE);
  });

  it('a keyed rent roll DOES measure occupancy, and drops the note', () => {
    // The refusal is about the provenance of the number, not about occupancy.
    // A rent roll is a measurement, so it is used and nothing is explained away.
    const screen = screenDeal(retail({ rentRoll: LET_ROLL, vacancyRate: 5 }));

    const occupancy = criterion(screen, 'occupancyPct');
    expect(occupancy.status).toBe('pass');
    expect(occupancy.value).toBeCloseTo(80, 6);
    expect(screen.notes).toHaveLength(0);
  });

  it('applies to both boxes, because both of them grade occupancy', () => {
    // Stated rather than assumed. screenDeal guards the note on the criterion
    // existing, and that guard is unreachable while every box grades occupancy
    // — this is what would have to change for it to start mattering, so a box
    // added without an occupancy criterion fails here rather than quietly
    // acquiring an explanation for a row it does not have.
    for (const deal of [retail({ vacancyRate: 5 }), multifamily({ vacancyRate: 5 })]) {
      const screen = screenDeal(deal);
      expect(criterion(screen, 'occupancyPct'), deal.propertyType).toBeDefined();
      expect(screen.notes, deal.propertyType).toContain(OCCUPANCY_NOTE);
    }
  });

  it('carries no note when the deal never had a vacancy rate to explain', () => {
    const screen = screenDeal(retail({}));
    expect(criterion(screen, 'occupancyPct').status).toBe('unknown');
    expect(screen.notes).toHaveLength(0);
  });
});

describe('a field the analyst has not filled in is an absence, not a failure', () => {
  it('a brand new deal is incomplete, not out of the box', () => {
    // blankDeal() initialises price, size and unit count to 0. Graded as
    // numbers, a $0 price is below a $1M floor and a 0-unit building is below a
    // 16-unit floor, so every deal would be born failing two hard criteria —
    // and the column would be red from the moment the analyst clicked New.
    const screen = screenDeal(blankDeal());

    expect(screen.verdict).toBe('incomplete');
    expect(screen.failed).toBe(0);
    expect(criterion(screen, 'price').status).toBe('unknown');
    expect(criterion(screen, 'units').status).toBe('unknown');
  });

  it('strips the zero only where zero cannot be a reading', () => {
    const adapted = adaptDeal({ purchasePrice: 0, buildingSize: 0, units: 0, yearBuilt: 0 });
    for (const key of ['purchasePrice', 'buildingSize', 'units', 'yearBuilt']) {
      expect(adapted[key]).toBeUndefined();
    }
    // A real price is untouched. Stripping by key rather than by value would
    // be the obvious bug here.
    expect(adaptDeal({ purchasePrice: 2400000 }).purchasePrice).toBe(2400000);
  });

  it('a flat 3-mile population is graded, not silenced', () => {
    // popGrowth3mi is deliberately NOT in ZERO_MEANS_UNSET: 0% is a real
    // reading — the population is stable — and the criterion reads "growing or
    // at least stable". Treating it as absent would silence the one site
    // criterion whose failure is a reason to walk.
    expect(ZERO_MEANS_UNSET).not.toContain('popGrowth3mi');

    expect(criterion(screenDeal(retail({ popGrowth3mi: 0 })), 'popGrowth3mi').status).toBe('pass');
    expect(criterion(screenDeal(retail({ popGrowth3mi: -1.2 })), 'popGrowth3mi').status).toBe('fail');
  });
});

describe('a property type with no box gets no verdict', () => {
  it.each(['carwash', 'office', 'industrial', undefined])('%s is not screened', (propertyType) => {
    expect(boxForDeal({ propertyType })).toBeNull();
    expect(screenDeal({ propertyType })).toBeNull();
  });

  it('retail and multifamily are screened against their own boxes', () => {
    expect(screenDeal(retail()).box).toBe('strip-center');
    expect(screenDeal(multifamily()).box).toBe('small-multifamily');
  });

  it('sorts below every screened deal', () => {
    // Not 0 and not null: either would let an unscreened car wash head a
    // shortlist sorted by how close deals are to the box.
    expect(verdictRank(null)).toBe(UNSCREENED_RANK);
    for (const v of Object.values(VERDICT)) expect(v.rank).toBeLessThan(UNSCREENED_RANK);
  });
});

describe('the verdicts order by severity, not by name', () => {
  it('runs pass, review, incomplete, fail', () => {
    // Alphabetically this is fail, incomplete, pass, review — which would put
    // the deals you have ruled out at the top of the column.
    const order = ['pass', 'review', 'incomplete', 'fail'].map((v) => VERDICT[v].rank);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(4);
  });

  it('gives every verdict a label and a tone', () => {
    for (const [key, v] of Object.entries(VERDICT)) {
      expect(v.label, key).toEqual(expect.any(String));
      expect(v.label.length, key).toBeGreaterThan(0);
      expect(v.tone, key).toEqual(expect.any(String));
    }
  });
});
