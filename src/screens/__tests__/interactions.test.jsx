/**
 * The same contract, on the states a reader has to CLICK to reach.
 *
 * A first render exercises one tab of the assumption band, one cash-flow
 * granularity, one sensitivity metric and one map radius. The defects this
 * project has shipped were not on the default view — clearing the hold period
 * white-screened the app from a keystroke in the Exit band, and the Grid posture
 * hides the flag list so a tile becomes the only statement of a covenant on
 * screen. So the panels get driven, and the same assertion runs after every
 * click: no NaN, no undefined, no Infinity.
 *
 * Edits go through a stateful wrapper that recomputes the deal exactly as App
 * does, because a screen that edits a deal and never sees it change is not the
 * screen anyone uses.
 */

import React, { useState } from 'react';

import DealModel from '../DealModel';
import CashFlow from '../CashFlow';
import Waterfall from '../Waterfall';
import Sensitivity from '../Sensitivity';
import MarketIntelligence from '../MarketIntelligence';
import ICMemo from '../ICMemo';
import Pipeline from '../Pipeline';

import { calculateMetrics } from '../../lib/finance';
import { METRICS, VARIABLES } from '../../lib/sensitivity';
import { propertyTypes } from '../../lib/propertyTypes';
import {
  renderScreen, withScreen, assertNoImpossibleNumbers, click, setValue, buttonsByText, text,
} from '../testing/renderScreen';
import { screenCases } from '../testing/cases';

const noop = () => {};
const caseFor = (key) => screenCases().find((c) => c.key === key).deal;

/** App's own update path: every edit recomputes metrics from the engine. */
function Live({ deal: initial, children }) {
  const [deal, setDeal] = useState(initial);
  return children(deal, (next) => setDeal({ ...next, metrics: calculateMetrics(next) }));
}

describe('DealModel, driven', () => {
  const GROUPS = ['Site & program', 'Dev budget', 'Revenue', 'OpEx', 'Financing', 'Exit'];

  it.each(GROUPS)('survives the %s assumption tab on every case', (group) => {
    for (const kase of screenCases()) {
      const { container, unmount } = renderScreen(
        <DealModel deal={kase.deal} onChange={noop} posture="form" onPosture={noop} />,
      );
      try {
        click(buttonsByText(container, new RegExp(`^${group.replace('&', '&')}$`))[0]);
        assertNoImpossibleNumbers(container, `DealModel · ${group} · ${kase.label}`);
      } finally {
        unmount();
      }
    }
  });

  it('survives the hold period being cleared to nothing, live', () => {
    // The keystroke that white-screened the entire application: the model then
    // reports an 18-month construction period with an empty months array, and
    // the draw curve indexed past the end of it.
    const { container, unmount } = renderScreen(
      <Live deal={caseFor('healthy')}>
        {(deal, onChange) => <DealModel deal={deal} onChange={onChange} posture="form" onPosture={noop} />}
      </Live>,
    );
    try {
      click(buttonsByText(container, /^Exit$/)[0]);
      const hold = [...container.querySelectorAll('.field')]
        .find((f) => /Hold period/.test(f.querySelector('label')?.textContent ?? ''))
        .querySelector('input');
      setValue(hold, '');
      assertNoImpossibleNumbers(container, 'DealModel after clearing the hold period');
      expect(text(container)).toContain('n/a');
    } finally {
      unmount();
    }
  });

  it('survives switching a live deal between equity share and the credit box', () => {
    const { container, unmount } = renderScreen(
      <Live deal={caseFor('healthy')}>
        {(deal, onChange) => <DealModel deal={deal} onChange={onChange} posture="form" onPosture={noop} />}
      </Live>,
    );
    try {
      click(buttonsByText(container, /^Credit box$/)[0]);
      assertNoImpossibleNumbers(container, 'DealModel sized to the credit box');
      click(buttonsByText(container, /^Equity share$/)[0]);
      assertNoImpossibleNumbers(container, 'DealModel back on the equity share');
    } finally {
      unmount();
    }
  });

  it('survives every property type on a blank deal', () => {
    const { container, unmount } = renderScreen(
      <Live deal={caseFor('blank')}>
        {(deal, onChange) => <DealModel deal={deal} onChange={onChange} posture="form" onPosture={noop} />}
      </Live>,
    );
    try {
      click(buttonsByText(container, /^Site & program$/)[0]);
      const select = [...container.querySelectorAll('.field select')].find((s) =>
        [...s.options].some((o) => o.value === 'industrial'));
      for (const key of Object.keys(propertyTypes)) {
        setValue(select, key);
        assertNoImpossibleNumbers(container, `DealModel on a blank ${key} deal`);
      }
    } finally {
      unmount();
    }
  });
});

describe('CashFlow, driven', () => {
  it.each(screenCases().map((c) => [c.label, c.deal]))('survives monthly granularity on %s', (label, deal) => {
    const { container, unmount } = renderScreen(<CashFlow deal={deal} />);
    try {
      click(buttonsByText(container, /^Monthly$/)[0]);
      assertNoImpossibleNumbers(container, `CashFlow monthly on ${label}`);
      click(buttonsByText(container, /^Annual$/)[0]);
      assertNoImpossibleNumbers(container, `CashFlow annual on ${label}`);
    } finally {
      unmount();
    }
  });
});

describe('Sensitivity, driven', () => {
  it.each(Object.keys(METRICS))('survives the %s metric on a healthy deal', (metric) => {
    const { container, unmount } = renderScreen(<Sensitivity deal={caseFor('healthy')} />);
    try {
      const select = [...container.querySelectorAll('select')].find((s) =>
        [...s.options].some((o) => o.value === metric && !/^rows:|^cols:/.test(o.textContent)));
      setValue(select, metric);
      assertNoImpossibleNumbers(container, `Sensitivity on ${METRICS[metric].label}`);
    } finally {
      unmount();
    }
  });

  it.each(Object.keys(VARIABLES))('survives %s on both axes of a blank deal', (variable) => {
    // A blank deal reads 0 for several of these, so the axis step falls out of a
    // percentage of zero — the shape that produces an axis of identical values,
    // and, unguarded, a NaN axis label.
    const { container, unmount } = renderScreen(<Sensitivity deal={caseFor('blank')} />);
    try {
      const [rows, cols] = [...container.querySelectorAll('select')].filter((s) =>
        [...s.options].some((o) => /^rows:|^cols:/.test(o.textContent)));
      setValue(rows, variable);
      setValue(cols, variable);
      assertNoImpossibleNumbers(container, `Sensitivity gridded on ${variable}`);
    } finally {
      unmount();
    }
  });
});

describe('Waterfall, driven', () => {
  it('survives applying, editing and removing a promote structure live', () => {
    const { container, unmount } = renderScreen(
      <Live deal={caseFor('healthy')}>
        {(deal, onChange) => <Waterfall deal={deal} onChange={onChange} />}
      </Live>,
    );
    try {
      click(buttonsByText(container, /^Apply to deal$/)[0]);
      assertNoImpossibleNumbers(container, 'Waterfall after applying the proposal');

      // Clearing a hurdle is a state an analyst passes through while retyping
      // one, and resolveWaterfall() refuses the structure in the meantime.
      const hurdle = [...container.querySelectorAll('.tier-card input')][0];
      if (hurdle) {
        setValue(hurdle, '');
        assertNoImpossibleNumbers(container, 'Waterfall with a hurdle cleared');
      }

      click(buttonsByText(container, /Hurdle tier/)[0]);
      assertNoImpossibleNumbers(container, 'Waterfall with an added tier');

      click(buttonsByText(container, /^Remove$/)[0]);
      assertNoImpossibleNumbers(container, 'Waterfall after removing the structure');
      expect([...container.querySelectorAll('.chip')].map((c) => c.textContent.trim()))
        .toContain('proposal only');
    } finally {
      unmount();
    }
  });

  it('survives every pref and tier-order combination on a promoted deal', () => {
    const { container, unmount } = renderScreen(
      <Live deal={caseFor('promoted')}>
        {(deal, onChange) => <Waterfall deal={deal} onChange={onChange} />}
      </Live>,
    );
    try {
      for (const label of [/^Simple$/, /^Compounds$/, /^Capital first$/, /^Pref first$/, /^Off$/, /^On$/]) {
        const button = buttonsByText(container, label)[0];
        if (button) {
          click(button);
          assertNoImpossibleNumbers(container, `Waterfall after ${label}`);
        }
      }
    } finally {
      unmount();
    }
  });
});

describe('MarketIntelligence, driven', () => {
  it('survives every radius and every property type', () => {
    const { container, unmount } = renderScreen(<MarketIntelligence deal={caseFor('healthy')} />);
    try {
      for (const radius of ['50 mi', '100 mi', '250 mi', 'All']) {
        click(buttonsByText(container, new RegExp(`^${radius}$`))[0]);
        assertNoImpossibleNumbers(container, `MarketIntelligence at ${radius}`);
      }
      const select = container.querySelector('select');
      for (const key of Object.keys(propertyTypes)) {
        setValue(select, key);
        assertNoImpossibleNumbers(container, `MarketIntelligence for ${key}`);
      }
    } finally {
      unmount();
    }
  });

  it('survives a market it has never heard of', () => {
    // findMarket() returns nothing, so there is no origin to rank against and
    // the screen falls back to scoring every market it knows.
    withScreen(
      <MarketIntelligence deal={{ ...caseFor('healthy'), location: 'Nowhere, ZZ' }} />,
      (c) => {
        assertNoImpossibleNumbers(c, 'MarketIntelligence on an unknown market');
        expect(c.innerHTML.length).toBeGreaterThan(0);
      },
    );
  });
});

describe('Pipeline, driven', () => {
  it('survives every saved view and every sort column', () => {
    const deals = screenCases().map((c, i) => ({ ...c.deal, id: i + 1 }));
    const { container, unmount } = renderScreen(<Pipeline deals={deals} onOpen={noop} onExport={noop} />);
    try {
      for (const view of ['All active', 'IC Thursday', 'Texas ground-up', 'DSCR at risk', 'Everything']) {
        click(buttonsByText(container, new RegExp(`^${view}$`))[0]);
        assertNoImpossibleNumbers(container, `Pipeline · ${view}`);
      }
      click(buttonsByText(container, /^Everything$/)[0]);
      for (const th of [...container.querySelectorAll('thead th')]) {
        // Sorting mixes real figures against nulls; the comparator has to put
        // the unknowns somewhere without turning them into numbers.
        click(th);
        assertNoImpossibleNumbers(container, `Pipeline sorted by ${th.textContent}`);
      }
    } finally {
      unmount();
    }
  });
});

describe('ICMemo, driven', () => {
  // jsdom implements no layout, so it has no scrollIntoView. That is an absent
  // browser API in the test environment, not a defect in the screen, so it is
  // stubbed rather than guarded away in ICMemo.
  beforeAll(() => { window.Element.prototype.scrollIntoView = () => {}; });

  it.each(['clearedHold', 'healthy', 'rejectedPromote'])(
    'survives navigating to every section of a %s memo', (key) => {
    const { container, unmount } = renderScreen(<ICMemo deal={caseFor(key)} />);
    try {
      for (const button of [...container.querySelectorAll('.memo-outline button')]) {
        click(button);
        assertNoImpossibleNumbers(container, `ICMemo section ${button.textContent}`);
      }
    } finally {
      unmount();
    }
  });
});
