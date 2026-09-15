/**
 * What a null is supposed to SAY.
 *
 * The companion to noImpossibleNumbers.test.js. That file pins the floor — no
 * NaN, no undefined, no Infinity. This one pins the contract above it: a figure
 * the model could not compute renders as an explicit absence, and never as a
 * zero, never as a percentage of nothing, and never as a covenant test that
 * passed. Those three are worse than a NaN, because they are readable.
 *
 * Every assertion here is about a CONTRACT. No dollar figure out of the engine
 * appears anywhere in this file: finance.js is changing, and a test that pins
 * one of its numbers pins the wrong thing.
 */

import React from 'react';

import Pipeline from '../Pipeline';
import DealModel from '../DealModel';
import CashFlow from '../CashFlow';
import Waterfall from '../Waterfall';
import Sensitivity from '../Sensitivity';
import ICMemo from '../ICMemo';

import { NA, pct } from '../../lib/format';
import { firmDefault } from '../../lib/firmDefaults';
import {
  renderScreen, withScreen, text, assertNoImpossibleNumbers, click, buttonsByText,
} from '../testing/renderScreen';
import { screenCases, INCOMPLETE_KEYS, withMetrics } from '../testing/cases';
import { SAMPLE_DEALS } from '../../lib/sampleDeals';
import { IRR_SHORT } from '../irrQualification';

const noop = () => {};
const caseFor = (key) => screenCases().find((c) => c.key === key).deal;
const incompleteCases = () => screenCases().filter((c) => INCOMPLETE_KEYS.includes(c.key));

/** A MetricStrip tile, by the label a reader sees. */
function tile(container, label) {
  const found = [...container.querySelectorAll('.m')].find(
    (el) => el.querySelector('.k')?.textContent.trim() === label,
  );
  if (!found) throw new Error(`no metric tile labelled "${label}"`);
  return {
    value: found.querySelector('.v')?.textContent.trim() ?? '',
    note: found.querySelector('.n')?.textContent.trim() ?? '',
    tone: found.querySelector('.v')?.className ?? '',
  };
}

describe('the absence convention', () => {
  it('is one string, and every screen uses it', () => {
    // Pinned so the suite below cannot quietly start accepting a blank cell or a
    // dash as "an absence". If this ever changes, every assertion here changes
    // with it deliberately rather than by accident.
    expect(NA).toBe('n/a');
  });

  it.each(incompleteCases().map((c) => [c.label, c.deal]))(
    'says so out loud on the Deal Model for %s',
    (_label, deal) => {
      withScreen(<DealModel deal={deal} onChange={noop} posture="form" onPosture={noop} />, (c) => {
        expect(text(c)).toContain(NA);
      });
    },
  );
});

describe('DealModel states what it could not compute', () => {
  it.each(incompleteCases().map((c) => [c.label, c.deal]))(
    'renders an unmodelled IRR and multiple as absences, not zeros (%s)',
    (_label, deal) => {
      withScreen(<DealModel deal={deal} onChange={noop} posture="form" onPosture={noop} />, (c) => {
        expect(tile(c, 'Levered IRR').value).toBe(NA);
        expect(tile(c, 'Equity multiple').value).toBe(NA);
        // The specific misreading: 0.0% is a claim that the deal returns
        // nothing. It does not; nobody has asked it the question yet.
        expect(tile(c, 'Levered IRR').value).not.toMatch(/0(\.0)?%/);
        expect(tile(c, 'Equity multiple').value).not.toMatch(/0(\.00)?×/);
      });
    },
  );

  it.each(incompleteCases().map((c) => [c.label, c.deal]))(
    'never reports a covenant as cleared on a metric it never measured (%s)',
    (_label, deal) => {
      withScreen(<DealModel deal={deal} onChange={noop} posture="form" onPosture={noop} />, (c) => {
        for (const label of ['Dev spread', 'DSCR stabilized']) {
          const t = tile(c, label);
          expect(t.value).toBe(NA);
          // 'clears' beside 'n/a' is a fabricated finding, and so is
          // 'breaches' — a value that does not exist cannot be on either side
          // of a limit.
          expect(t.note).toContain('not measured');
          expect(t.note).not.toMatch(/\bclears\b/);
          expect(t.note).not.toMatch(/\bbreaches\b/);
          expect(t.note).not.toMatch(/\bshort\b/);
          // A verdict tone is a colour a reader trusts. There is nothing to
          // colour here.
          expect(t.tone).not.toMatch(/\bneg\b/);
        }
      });
    },
  );

  it('reports a break-even occupancy it cannot solve as an absence with a reason', () => {
    withScreen(<DealModel deal={caseFor('blank')} onChange={noop} posture="form" onPosture={noop} />, (c) => {
      const t = tile(c, 'Break-even occupancy');
      expect(t.value).toBe(NA);
      // Never 0%: an empty building does not pay for itself.
      expect(t.value).not.toMatch(/0(\.0)?%/);
      expect(t.note.length).toBeGreaterThan(0);
    });
  });

  it('does not print a stabilization month a model without a schedule never reached', () => {
    withScreen(<DealModel deal={caseFor('clearedHold')} onChange={noop} posture="form" onPosture={noop} />, (c) => {
      // Month 0 is a real month — the closing — so this cannot fall back to a
      // number, and the bare interpolation used to put the string "mo null" on
      // the tile.
      expect(text(c)).not.toContain('null');
      expect(tile(c, 'Yield on cost').note).toContain(NA);
    });
  });

  it('renders a null capital-stack component as an absence, not as a share of nothing', () => {
    // The model is COMPLETE here — total project cost is a real number — but the
    // co-invest and LP equity are null. `null / total` is 0 in JavaScript, so an
    // unguarded share printed a confident 0.0% beside an amount reading n/a.
    withScreen(<DealModel deal={caseFor('unusableCoInvest')} onChange={noop} posture="form" onPosture={noop} />, (c) => {
      const rows = [...c.querySelectorAll('div')].filter(
        (el) => el.children.length >= 4 && /GP co-invest|LP equity/.test(el.textContent),
      );
      expect(rows.length).toBeGreaterThan(0);
      const stackRow = rows[rows.length - 1];
      const cells = [...stackRow.querySelectorAll('span')].map((s) => s.textContent.trim());
      expect(cells).toContain(NA);
      expect(cells.filter((v) => v === '0.0%')).toHaveLength(0);
    });
  });
});

describe('Pipeline states what it could not compute', () => {
  it.each(incompleteCases().map((c) => [c.label, c.deal]))(
    'renders unmodelled columns as absences (%s)',
    (_label, deal) => {
      withScreen(<Pipeline deals={[deal]} onOpen={noop} onExport={noop} />, (c) => {
        const cells = [...c.querySelectorAll('tbody td')].map((td) => td.textContent.trim());
        expect(cells).toContain(NA);
        // The IRR, TDC and equity columns cannot read as a real figure on a
        // deal that has no schedule at all.
        expect(cells.filter((v) => v === '0.0%' || v === '$0')).toHaveLength(0);
      });
    },
  );

  it('reports a weighted portfolio IRR over unknown equity as an absence', () => {
    withScreen(
      <Pipeline deals={incompleteCases().map((c, i) => ({ ...c.deal, id: i + 1 }))} onOpen={noop} onExport={noop} />,
      (c) => {
        // Every deal contributes an unknown equity weight, so there is no
        // weighted average to report — not a 0.0% one.
        expect(text(c)).toContain(NA);
        expect(text(c)).not.toContain('0.0%');
      },
    );
  });
});

describe('CashFlow states what it could not compute', () => {
  it.each(incompleteCases().map((c) => [c.label, c.deal]))(
    'does not claim a stabilization month it never reached (%s)',
    (_label, deal) => {
      withScreen(<CashFlow deal={deal} />, (c) => {
        const chips = [...c.querySelectorAll('.chip')].map((el) => el.textContent.trim());
        // The old chip read "Stabilizes month " with nothing after it, and the
        // accent rule that marks stabilization was drawn on year one of a model
        // that never stabilised.
        expect(chips.some((v) => /Stabiliz/.test(v))).toBe(true);
        expect(chips).not.toContain('Stabilizes month');
        expect(chips.some((v) => v.includes(NA))).toBe(true);
      });
    },
  );
});

describe('Waterfall never shows a split it did not run', () => {
  it('says the terms are a proposal when the deal carries no structure', () => {
    withScreen(<Waterfall deal={caseFor('healthy')} onChange={noop} />, (c) => {
      const chips = [...c.querySelectorAll('.chip')].map((el) => el.textContent.trim());
      expect(chips).toContain('proposal only');
      expect(chips).not.toContain('on the deal');
    });
  });

  it.each([['a complete model', 'rejectedPromote'], ['an incomplete model', 'rejectedPromoteIncomplete']])(
    'shows no distribution tiers at all for a structure the engine refuses, on %s',
    (_label, key) => {
      withScreen(<Waterfall deal={caseFor(key)} onChange={noop} />, (c) => {
        // The alternative to showing nothing is showing a fabricated split, and
        // the callout has to say which of the two states this is.
        expect(text(c)).toMatch(/no arithmetic|no equity cash flow/i);
        const panels = [...c.querySelectorAll('.lbl')].map((el) => el.textContent.trim());
        expect(panels).not.toContain('Distribution tiers');
        expect(panels).not.toContain('Split of distributions');
      });
    },
  );

  it('quotes the firm default co-invest when no capital stack was funded', () => {
    // With no schedule there is no stack to derive a share from, and the
    // arithmetic returns a confident 0.0% for a deal whose configured co-invest
    // is the house standard. The fallback is the firm default — read from
    // firmDefaults, the same expression finance.js resolves — not a literal
    // copied into this component.
    const deal = caseFor('clearedHold');
    const expected = pct(firmDefault('gpCoInvestShare', deal.propertyType), 1);
    withScreen(<Waterfall deal={deal} onChange={noop} />, (c) => {
      const chips = [...c.querySelectorAll('.chip')].map((el) => el.textContent.trim());
      expect(chips).toContain(`GP co-invest ${expected}`);
      expect(chips).not.toContain('GP co-invest 0.0%');
    });
  });
});

describe('Sensitivity states what it could not solve', () => {
  it.each(incompleteCases().map((c) => [c.label, c.deal]))(
    'renders unsolvable scenarios and breakevens as absences (%s)',
    (_label, deal) => {
      withScreen(<Sensitivity deal={deal} />, (c) => {
        const cells = [...c.querySelectorAll('td')].map((td) => td.textContent.trim());
        expect(cells).toContain(NA);
        // A breakeven that has no solution in the search range is not a zero
        // dollar breakeven.
        expect(cells.filter((v) => v === '$0' || v === '0.00%')).toHaveLength(0);
      });
    },
  );
});

describe('ICMemo never presents an unscreened deal as one that passed', () => {
  it.each(incompleteCases().map((c) => [c.label, c.deal]))(
    'does not tone the screening chip as a pass for %s',
    (_label, deal) => {
      withScreen(<ICMemo deal={deal} />, (c) => {
        const chip = [...c.querySelectorAll('.chip')].find((el) => /Incomplete|criteria/.test(el.textContent));
        expect(chip).toBeTruthy();
        // screeningVerdict() returns NO failedCount at all on an incomplete
        // model, and `failedCount ? 'warn' : 'pos'` read that undefined as zero
        // failures — a green chip over a memo whose every figure is n/a.
        expect(chip.className.split(/\s+/)).not.toContain('pos');
      });
    },
  );

  it.each(incompleteCases().map((c) => [c.label, c.deal]))(
    'renders the verdict block on the page as a non-pass for %s',
    (_label, deal) => {
      withScreen(<ICMemo deal={deal} />, (c) => {
        const verdicts = [...c.querySelectorAll('.verdict')];
        expect(verdicts.length).toBeGreaterThan(0);
        for (const v of verdicts) expect(v.className).toContain('fail');
      });
    },
  );

  it('still tones the chip as a pass when the deal actually clears every test', () => {
    // The negative above is only worth anything if the positive still happens.
    const passing = screenCases()
      .filter((c) => !INCOMPLETE_KEYS.includes(c.key))
      .map((c) => c.deal);
    const tones = passing.map((deal) =>
      withScreen(<ICMemo deal={deal} />, (c) => {
        const chip = [...c.querySelectorAll('.chip')].find((el) => /Incomplete|criteria/.test(el.textContent));
        return { text: chip.textContent.trim(), pass: chip.className.split(/\s+/).includes('pos') };
      }),
    );
    for (const t of tones) {
      expect(t.text).not.toBe('Incomplete');
      // A verdict that met every criterion is toned as a pass; one that did not
      // is not. Either way the tone agrees with the words beside it.
      expect(t.pass).toBe(t.text === 'Meets all stated criteria');
    }
  });
});

/**
 * The mocked suite in irrUniqueness.test.js drives the flag directly. This one
 * checks the wiring against the REAL engine on the real sample portfolio: no
 * mock, no injected diagnostics, no pinned figure. It asserts only that the
 * number of qualified rows equals the number of models that withdraw the
 * guarantee — so it stays correct whichever deals the engine's arithmetic moves
 * into or out of that state.
 */
describe('the IRR qualification reaches a screen on real engine output', () => {
  const marks = (container) => [...container.querySelectorAll('[title]')]
    .filter((el) => new RegExp(IRR_SHORT, 'i').test(el.getAttribute('title')));

  it('marks exactly the pipeline rows whose model withdraws the guarantee', () => {
    const deals = SAMPLE_DEALS.map((d) => withMetrics(d));
    const expected = deals.filter(
      (d) => d.metrics.model.returns.irrDiagnostics.levered.uniquenessGuaranteed === false,
    ).length;
    const { container, unmount } = renderScreen(<Pipeline deals={deals} onOpen={noop} onExport={noop} />);
    try {
      // The default saved view hides closed deals; every row has to be on
      // screen for the count to mean anything.
      click(buttonsByText(container, /^Everything$/)[0]);
      expect(marks(container)).toHaveLength(expected);
      if (expected > 0) expect(text(container)).toMatch(new RegExp(IRR_SHORT, 'i'));
    } finally {
      unmount();
    }
  });
});

describe('the absence check itself is not vacuous', () => {
  it('catches an impossible number in text and in an attribute', () => {
    const Bad = () => (
      <div>
        <span>{String(0 / 0)}</span>
        <i style={{ width: `${(null) / 0}%` }} title={`${undefined}`} />
      </div>
    );
    withScreen(<Bad />, (c) => {
      expect(() => assertNoImpossibleNumbers(c, 'a deliberately broken component')).toThrow(/NaN/);
      expect(() => assertNoImpossibleNumbers(c, 'a deliberately broken component')).toThrow(/undefined/);
    });
  });

  it('says nothing about a component that renders only absences', () => {
    const Good = () => <div title={NA}>{NA}</div>;
    withScreen(<Good />, (c) => {
      expect(() => assertNoImpossibleNumbers(c, 'a clean component')).not.toThrow();
    });
  });

  it('reads attributes, not just text', () => {
    // The SVG path `d`, the inline width percentage and the tooltip are where
    // the arithmetic bugs actually hide: none of them is visible as text.
    const Hidden = () => <svg><path d={`M0,${0 / 0}`} /></svg>;
    withScreen(<Hidden />, (c) => {
      expect(text(c)).not.toContain('NaN');
      expect(() => assertNoImpossibleNumbers(c, 'a chart with a broken path')).toThrow(/NaN/);
    });
  });
});
