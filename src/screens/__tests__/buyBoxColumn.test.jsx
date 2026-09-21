/**
 * The buy box, as the pipeline shows it.
 *
 * Two things are being guarded. The first is that the column reports what the
 * screen actually returned — a verdict, or an absence for an asset class no box
 * covers — rather than defaulting a missing one to something harmless. The
 * second is that reading WHY a deal is outside the box does not navigate away
 * from the list you are reading it against, which is the failure a nested
 * control inside a clickable row produces by default.
 */

import React from 'react';

import Pipeline from '../Pipeline';
import { NA } from '../../lib/format';
import {
  renderScreen, withScreen, click, text, buttonsByText, assertNoImpossibleNumbers,
} from '../testing/renderScreen';
import { withMetrics } from '../testing/cases';
import { SAMPLE_DEALS } from '../../lib/sampleDeals';
import { VERDICT, screenDeal } from '../../lib/buyBoxView';

const noop = () => {};

const pipeline = (deals, over = {}) => (
  <Pipeline deals={deals} onOpen={noop} onExport={noop} {...over} />
);

/** The Box column's index, found by its header rather than hard-coded. */
function boxColumnIndex(container) {
  const headers = [...container.querySelectorAll('thead th')];
  const i = headers.findIndex((th) => th.textContent.replace(/[↓↑\s]/g, '') === 'Box');
  if (i < 0) throw new Error(`no Box column; headers were ${headers.map((h) => h.textContent)}`);
  return i;
}

const dataRows = (container) =>
  [...container.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('td.name'));

const boxCell = (container, rowIndex = 0) =>
  dataRows(container)[rowIndex].children[boxColumnIndex(container)];

/**
 * Fixtures, chosen ACTIVE.
 *
 * The pipeline opens on the All active view, so a Closed sample deal renders as
 * an empty table and every assertion below passes vacuously — which is how the
 * first draft of this file reported three greens against nothing on screen.
 */
const active = (pred) => {
  const deal = SAMPLE_DEALS.find((d) => d.stage !== 'Closed' && pred(d));
  if (!deal) throw new Error('no active sample deal matches this fixture');
  return withMetrics(deal);
};
const SCREENED_TYPES = ['retail', 'multifamily'];
const outsideTheBox = () => active((d) => d.propertyType === 'retail');
const unscreened = () => active((d) => !SCREENED_TYPES.includes(d.propertyType));

/**
 * A retail centre in every verdict, for the assertions about ORDER.
 *
 * The sample portfolio cannot serve here: every deal in it that a box covers is
 * `fail`, so a column sorted by verdict and a column sorted by label produce
 * the same single-valued order and neither test can tell them apart. That is
 * how the first version of the sort test below passed against a mutant that
 * sorted alphabetically.
 *
 * Lease terms are struck RELATIVE TO NOW rather than written as dates. The
 * pipeline screens against the current date, so a fixed 2032 expiry makes this
 * suite start failing in 2029 for no reason connected to the code.
 */
const yearsOut = (n) => new Date(Date.now() + n * 365.25 * 864e5).toISOString().slice(0, 10);

const bay = (i, over = {}) => ({
  tenant: `Tenant ${i}`,
  category: 'professional',
  squareFeet: 1500,
  baseRentAnnual: 27000,        // $18.00/SF against a $20 market view
  leaseStart: yearsOut(-2),
  leaseEnd: yearsOut(6),
  recovery: 'nnn',
  marketRentPSF: 20,
  ...over,
});

/** 12,000 SF over 8 bays, 7 let: inside every criterion in the strip-centre box. */
const inTheBox = (over = {}) => withMetrics({
  id: 9001,
  name: 'Maple Crossing',
  stage: 'Screening',
  propertyType: 'retail',
  constructionType: 'acquisition',
  location: 'Columbus, OH',
  purchasePrice: 1800000,
  yearBuilt: 1998,
  trafficCount: 22000,
  parkingSpaces: 60,
  popGrowth3mi: 1.4,
  rentRoll: [
    bay(1), bay(2), bay(3),
    bay(4, { category: 'qsr' }),
    bay(5, { category: 'medical' }),
    bay(6), bay(7),
    { vacant: true, category: 'vacant', squareFeet: 1500 },
  ],
  ...over,
});

/** One of each verdict, as `{ verdict, deal }`. */
const spanningVerdicts = () => [
  { verdict: 'pass', deal: inTheBox() },
  // A soft criterion only: a declining 3-mile population is a conversation.
  { verdict: 'review', deal: inTheBox({ id: 9002, name: 'Cedar Plaza', popGrowth3mi: -0.8 }) },
  // A hard one: outside the price range is not your deal.
  { verdict: 'fail', deal: inTheBox({ id: 9003, name: 'Birch Center', purchasePrice: 5200000 }) },
  // Nothing keyed in but the price.
  {
    verdict: 'incomplete',
    deal: withMetrics({
      id: 9004, name: 'Elm Corners', stage: 'Screening', propertyType: 'retail',
      constructionType: 'acquisition', location: 'Dayton, OH', purchasePrice: 1800000,
    }),
  },
];

describe('the Box column reports the screen, including its absence', () => {
  it('shows the verdict for a deal a box covers', () => {
    const deal = outsideTheBox();
    // Pinned against the library rather than against a literal, so the column
    // and the module cannot drift apart while both stay internally consistent.
    const expected = VERDICT[screenDeal(deal).verdict].label;

    withScreen(pipeline([deal]), (c) => {
      expect(boxCell(c).textContent).toBe(expected);
    });
  });

  it('shows an absence, not a verdict, for a property type no box covers', () => {
    // A car wash graded on bay count and restaurant share is a column of red
    // against rules that never applied to it, and a reader who learns to
    // ignore this column has lost the one beside it too.
    const deal = unscreened();
    expect(screenDeal(deal)).toBeNull();

    withScreen(pipeline([deal]), (c) => {
      const cell = boxCell(c);
      expect(cell.textContent).toBe(NA);
      expect(cell.querySelector('button')).toBeNull();
    });
  });

  it('never renders an impossible number in the column or its detail', () => {
    const deals = [outsideTheBox(), unscreened()];
    const { container, unmount } = renderScreen(pipeline(deals));
    try {
      assertNoImpossibleNumbers(container, 'Pipeline with the Box column');
      // By chip, not by row index: the table is sorted on IRR, so which of the
      // two rows is first is the engine's business, not this test's.
      click(container.querySelector('tbody button.chip'));
      assertNoImpossibleNumbers(container, 'Pipeline with the buy box detail open');
    } finally {
      unmount();
    }
  });
});

describe('reading the criteria does not open the deal', () => {
  it('expands the criteria in place, and calls nothing', () => {
    const deal = outsideTheBox();
    const screen = screenDeal(deal);
    const missed = screen.results.find((r) => r.status === 'fail');
    expect(missed, 'this fixture must miss at least one criterion').toBeDefined();

    let opened = 0;
    const { container, unmount } = renderScreen(
      pipeline([deal], { onOpen: () => { opened += 1; } }),
    );
    try {
      const chip = boxCell(container).querySelector('button');
      expect(chip.getAttribute('aria-expanded')).toBe('false');
      expect(text(container)).not.toContain(missed.threshold);

      click(chip);

      // The row's own onClick must not have fired. Without stopPropagation the
      // reader lands on the Deal Model screen and never sees the criteria.
      expect(opened).toBe(0);
      expect(boxCell(container).querySelector('button').getAttribute('aria-expanded')).toBe('true');

      // The measured value beside its threshold — a verdict without the
      // distance is a score, and a score is what a buy box replaces.
      const shown = text(container);
      expect(shown).toContain(missed.label);
      expect(shown).toContain(missed.display);
      expect(shown).toContain(missed.threshold);
    } finally {
      unmount();
    }
  });

  it('lists what has to be measured next', () => {
    const deal = outsideTheBox();
    const screen = screenDeal(deal);
    const firstMissing = screen.results.find((r) => r.key === screen.missing[0]);
    expect(firstMissing).toBeDefined();

    withScreen(pipeline([deal]), (c) => {
      click(boxCell(c).querySelector('button'));
      expect(text(c)).toContain('To finish the screen');
      expect(text(c)).toContain(firstMissing.label);
    });
  });

  it('clicking the row still opens the deal', () => {
    // The guard above must not have been bought by disabling the row.
    let opened = null;
    const deal = outsideTheBox();
    withScreen(pipeline([deal], { onOpen: (d) => { opened = d; } }), (c) => {
      click(dataRows(c)[0].querySelector('td.name'));
      expect(opened).toBe(deal);
    });
  });

  it('closes again, and only one row is open at a time', () => {
    const deals = [outsideTheBox(), active((d) => d.propertyType === 'multifamily')];

    withScreen(pipeline(deals), (c) => {
      click(boxCell(c, 0).querySelector('button'));
      const openAfterFirst = () =>
        [...c.querySelectorAll('tbody button.chip')].filter((b) => b.getAttribute('aria-expanded') === 'true');
      expect(openAfterFirst()).toHaveLength(1);

      click(boxCell(c, 1).querySelector('button'));
      expect(openAfterFirst()).toHaveLength(1);

      click(boxCell(c, 1).querySelector('button'));
      expect(openAfterFirst()).toHaveLength(0);
    });
  });
});

describe('the Buy box view and the Box sort', () => {
  it('the view drops the asset classes no box was written for', () => {
    const covered = SAMPLE_DEALS.filter((d) => SCREENED_TYPES.includes(d.propertyType));
    const deals = SAMPLE_DEALS.map(withMetrics);
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.length).toBeLessThan(SAMPLE_DEALS.length);

    withScreen(pipeline(deals), (c) => {
      const [button] = buttonsByText(c, /^Buy box$/);
      expect(button, 'no Buy box saved view').toBeDefined();
      click(button);

      const names = dataRows(c).map((tr) => tr.querySelector('td.name').textContent);
      expect(names).toHaveLength(covered.length);
      for (const d of covered) expect(names.some((n) => n.startsWith(d.name))).toBe(true);
    });
  });

  it('sorts by severity, so the deals still in play head the column', () => {
    const cases = spanningVerdicts();
    // The fixture has to reach all four, or the assertion below cannot separate
    // a sort on the verdict from a sort on its label.
    for (const { verdict, deal } of cases) expect(screenDeal(deal).verdict, deal.name).toBe(verdict);
    expect(new Set(cases.map((x) => x.verdict)).size).toBe(4);

    // Alphabetically the labels run Bincomplete… — In box, Incomplete, Outside,
    // Review — which buries `review` under the two verdicts you have already
    // dealt with and puts `incomplete` above deals that are actually in the box.
    const alphabetical = [...cases]
      .map((x) => VERDICT[x.verdict].label)
      .sort((a, b) => a.localeCompare(b));
    const bySeverity = ['pass', 'review', 'incomplete', 'fail'].map((v) => VERDICT[v].label);
    expect(alphabetical).not.toEqual(bySeverity);

    withScreen(pipeline(cases.map((x) => x.deal)), (c) => {
      const header = [...c.querySelectorAll('thead th')][boxColumnIndex(c)];
      click(header);   // first click sorts descending: worst first
      click(header);   // second ascending: the deals still in play at the top

      const labels = dataRows(c)
        .map((tr) => tr.children[boxColumnIndex(c)].textContent)
        .filter((t) => t !== NA);
      expect(labels).toEqual(bySeverity);
    });
  });

  it('states what the verdicts mean, under a table that shows them', () => {
    withScreen(pipeline([outsideTheBox()]), (c) => {
      expect(text(c)).toContain('has not taken the test');
    });
    // …and not under one that does not.
    withScreen(pipeline([unscreened()]), (c) => {
      expect(text(c)).not.toContain('has not taken the test');
    });
  });
});

/**
 * The Market Intelligence banner, which states what the market table is made of.
 *
 * Lives here rather than in its own file because it guards the same failure as
 * the Box column: a label that reports something other than what the data says.
 */
describe('the market data banner is computed, not written down', () => {
  it('reports the real count of markets and the real share that is sourced', async () => {
    const { default: MarketIntelligence } = await import('../MarketIntelligence');
    const { markets, fieldQuality, MARKET_DATA_FIELDS } = await import('../../lib/markets');

    const total = markets.length * MARKET_DATA_FIELDS.length;
    const sourced = markets
      .flatMap((m) => MARKET_DATA_FIELDS.map((f) => fieldQuality(m, f)))
      .filter((q) => q === 'sourced').length;

    withScreen(<MarketIntelligence deal={null} />, (c) => {
      const shown = text(c);
      expect(shown).toContain(`${markets.length} markets`);
      expect(shown).toContain(`${Math.round((sourced / total) * 100)}% of fields sourced`);
      // Today that is 0%, and the banner has to be willing to say so rather
      // than rounding an empty overlay up into a reassuring phrase.
      expect(sourced).toBe(0);
      expect(shown).toContain('the rest seed data');
    });
  });
});

/**
 * The market radius control, whose widest setting claims to show everything.
 *
 * That claim was true while every market was in Texas or Florida and false the
 * moment the Midwest records landed — Houston to Detroit is about 1,100 miles
 * against a widest filter of 1,000. Nothing failed; nine markets were simply
 * not there, behind a control labelled "All".
 */
describe('the widest market radius shows every market', () => {
  it('reaches a market further away than any fixed radius on the control', async () => {
    const { default: MarketIntelligence } = await import('../MarketIntelligence');
    const { findMarket, distanceMiles, markets } = await import('../../lib/markets');
    const { withMetrics: wm } = await import('../testing/cases');

    const houston = findMarket('Houston, TX');
    const furthest = markets
      .map((m) => ({ m, d: distanceMiles(houston, m) }))
      .sort((a, b) => b.d - a.d)[0];
    // The premise: something really is beyond the widest NUMBERED option.
    expect(furthest.d).toBeGreaterThan(1000);

    const deal = wm({ ...SAMPLE_DEALS[0], location: 'Houston, TX' });
    withScreen(<MarketIntelligence deal={deal} />, (c) => {
      expect(text(c)).not.toContain(furthest.m.city);
      click(buttonsByText(c, /^All$/)[0]);
      expect(text(c)).toContain(furthest.m.city);
    });
  });

  it('never prints Infinity, whatever the control is set to', async () => {
    // Infinity is the honest value for "no radius" and the dishonest thing to
    // render. It reaches the DOM through the empty-state message first.
    const { default: MarketIntelligence } = await import('../MarketIntelligence');

    const { container, unmount } = renderScreen(<MarketIntelligence deal={null} />);
    try {
      for (const label of ['50 mi', '100 mi', '250 mi', '500 mi', 'All']) {
        const [btn] = buttonsByText(container, new RegExp(`^${label}$`));
        expect(btn, label).toBeDefined();
        click(btn);
        assertNoImpossibleNumbers(container, `Market Intelligence at ${label}`);
      }
    } finally {
      unmount();
    }
  });
});
