/**
 * The check that would have caught nearly every screen defect this project has
 * had: render each screen against a healthy deal, two shapes of incomplete deal,
 * a promoted deal, a deal whose promote the waterfall refuses, and a blank deal,
 * and assert that no impossible number reaches the DOM.
 *
 * NaN, undefined and Infinity on an underwriting screen are not cosmetic. They
 * are the visible end of a division by an unknown, a template literal over an
 * absent field, or a solver that overflowed — and until this file existed every
 * one of them was found by a human clicking, by Playwright on a built bundle, or
 * not at all. Clearing the hold period white-screened the whole application from
 * one keystroke in the Exit band; a null co-invest printed a confident 0.0%.
 *
 * Deliberately NOT asserted here: any figure out of the engine. finance.js is
 * under active change. What is pinned is the contract — an absence renders as an
 * absence — not the arithmetic.
 */

import React from 'react';

import Pipeline from '../Pipeline';
import DealModel from '../DealModel';
import CashFlow from '../CashFlow';
import Waterfall from '../Waterfall';
import Sensitivity from '../Sensitivity';
import MarketIntelligence from '../MarketIntelligence';
import ICMemo from '../ICMemo';

import { withScreen, assertNoImpossibleNumbers } from '../testing/renderScreen';
import { screenCases } from '../testing/cases';

const noop = () => {};

/** Every screen, with the props App hands it. */
const SCREENS = [
  { name: 'Pipeline', render: (deal) => <Pipeline deals={[deal]} onOpen={noop} onExport={noop} /> },
  { name: 'DealModel', render: (deal) => <DealModel deal={deal} onChange={noop} posture="form" onPosture={noop} /> },
  { name: 'DealModel (grid posture)', render: (deal) => <DealModel deal={deal} onChange={noop} posture="grid" onPosture={noop} /> },
  { name: 'CashFlow', render: (deal) => <CashFlow deal={deal} /> },
  { name: 'Waterfall', render: (deal) => <Waterfall deal={deal} onChange={noop} /> },
  { name: 'Sensitivity', render: (deal) => <Sensitivity deal={deal} /> },
  { name: 'MarketIntelligence', render: (deal) => <MarketIntelligence deal={deal} /> },
  { name: 'ICMemo', render: (deal) => <ICMemo deal={deal} /> },
];

describe.each(SCREENS.map((s) => [s.name, s]))('%s', (name, screen) => {
  it.each(screenCases().map((c) => [c.label, c]))(
    'renders %s without NaN, undefined or Infinity',
    (label, kase) => {
      withScreen(screen.render(kase.deal), (container) => {
        assertNoImpossibleNumbers(container, `${name} on ${label}`);
      });
    },
  );

  it.each(screenCases().map((c) => [c.label, c]))('renders %s at all', (label, kase) => {
    // A screen that throws during render takes the entire application down with
    // it — rail, header and every other screen — because nothing above it is an
    // error boundary. That is not a degraded view, it is a white page.
    withScreen(screen.render(kase.deal), (container) => {
      expect(container.innerHTML.length).toBeGreaterThan(0);
    });
  });
});

/**
 * The whole pipeline at once, which is what App actually renders: every case
 * side by side in one table, sorted and rolled up together. A portfolio roll-up
 * divides by a total that an incomplete deal contributes nothing to.
 */
describe('Pipeline with the whole mixed portfolio', () => {
  it('renders every case together without an impossible number', () => {
    const deals = screenCases().map((c, i) => ({ ...c.deal, id: i + 1 }));
    withScreen(<Pipeline deals={deals} onOpen={noop} onExport={noop} />, (container) => {
      assertNoImpossibleNumbers(container, 'Pipeline on the mixed portfolio');
    });
  });
});
