/**
 * Surfacing `returns.irrDiagnostics`.
 *
 * finance.js solves every IRR by bisection and returns the FIRST bracketed root.
 * It publishes `{signChanges, uniquenessGuaranteed}` per series on
 * `returns.irrDiagnostics`, and nothing in the app read it — so a rate PROVED to
 * be the deal's return and one that merely had not been disproved rendered in
 * identical type.
 *
 * What is asserted here is the three-state contract, not the arithmetic:
 *
 *   uniquenessGuaranteed === true  → say nothing; the figure is proved
 *   uniquenessGuaranteed === null  → say nothing; nothing was established
 *   uniquenessGuaranteed === false → qualify the figure, do not suppress it,
 *                                    and do NOT claim several rates exist —
 *                                    the flag withdraws a guarantee, and the
 *                                    engine's own comment says every sample deal
 *                                    that trips it has exactly one real IRR
 *
 * The engine is stubbed at its `runModel`/`calculateMetrics` boundary so the
 * flag can be driven directly. Building a deal whose real flows turn over twice
 * would pin an engine behaviour that is under active change, and the screens
 * would then be tested against yesterday's arithmetic rather than today's
 * contract.
 */

import React from 'react';

let mockIrrOverride = null;

jest.mock('../../lib/finance', () => {
  const actual = jest.requireActual('../../lib/finance');
  const stamp = (model) =>
    mockIrrOverride && model && model.returns
      ? { ...model, returns: { ...model.returns, irrDiagnostics: mockIrrOverride } }
      : model;
  return {
    ...actual,
    runModel: (deal) => stamp(actual.runModel(deal)),
    calculateMetrics: (deal) => {
      const metrics = actual.calculateMetrics(deal);
      return { ...metrics, model: stamp(metrics.model) };
    },
  };
});

/* eslint-disable import/first */
import Pipeline from '../Pipeline';
import DealModel from '../DealModel';
import Waterfall from '../Waterfall';
import Sensitivity from '../Sensitivity';

import { irrQualification, IRR_MARK, IRR_FOOTNOTE, IRR_SHORT } from '../irrQualification';
import { runModel } from '../../lib/finance';
import { withScreen, text, assertNoImpossibleNumbers } from '../testing/renderScreen';
import { screenCases, RUNNABLE_PROMOTE, withMetrics } from '../testing/cases';
import { SAMPLE_DEALS } from '../../lib/sampleDeals';
/* eslint-enable import/first */

const noop = () => {};

// The field finance.js publishes is `uniquenessGuaranteed`, NOT `unique`, and
// the name carries the meaning: `false` withdraws a guarantee, it does not
// assert that several rates exist. The contract test below pins the name so a
// rename in the engine fails here rather than silently switching every screen's
// qualification off.
const series = (uniquenessGuaranteed, signChanges) => ({
  levered: { signChanges, uniquenessGuaranteed },
  unlevered: { signChanges, uniquenessGuaranteed },
});

const NOT_GUARANTEED = series(false, 3);
const GUARANTEED = series(true, 1);
// The shape runModel()'s degenerate path returns: no series was built, so
// uniqueness is not a fact this model established.
const UNKNOWN = series(null, null);

afterEach(() => { mockIrrOverride = null; });

/** Deals are built AFTER the flag is set, so their metrics carry it. */
const healthyDeal = () => withMetrics({ ...SAMPLE_DEALS[0] });
const promotedDeal = () => withMetrics({ ...SAMPLE_DEALS[0], waterfall: RUNNABLE_PROMOTE });

/** The qualification is attached to the figure by a title, not by prose alone. */
const marks = (container) => [...container.querySelectorAll('[title]')]
  .filter((el) => new RegExp(IRR_SHORT, 'i').test(el.getAttribute('title')));

describe('irrQualification', () => {
  it('says nothing when the model guarantees uniqueness', () => {
    expect(irrQualification(GUARANTEED, 'levered')).toBeNull();
    expect(irrQualification(GUARANTEED, 'unlevered')).toBeNull();
  });

  it('reads the field finance.js actually publishes', () => {
    // The engine deliberately does NOT call this `unique`, and reading the wrong
    // key would leave every screen's qualification silently switched off — the
    // exact state this whole file exists to end. Pinned as a contract between
    // the engine and the screens.
    const d = runModel({ ...SAMPLE_DEALS[0] }).returns.irrDiagnostics;
    expect(d.levered).toHaveProperty('uniquenessGuaranteed');
    expect(d.unlevered).toHaveProperty('uniquenessGuaranteed');
    expect([true, false, null]).toContain(d.levered.uniquenessGuaranteed);
    // And the helper's verdict tracks that field rather than any other.
    expect(irrQualification({ levered: { ...d.levered, uniquenessGuaranteed: false } }, 'levered')).not.toBeNull();
    expect(irrQualification({ levered: { ...d.levered, uniquenessGuaranteed: true } }, 'levered')).toBeNull();
  });

  it('says nothing when the flag is unknown rather than false', () => {
    // The one distinction the brief turns on: null is not false. An incomplete
    // model built no flow series, so a caveat here would invent a doubt the
    // model does not claim.
    expect(irrQualification(UNKNOWN, 'levered')).toBeNull();
    expect(irrQualification(undefined, 'levered')).toBeNull();
    expect(irrQualification({}, 'levered')).toBeNull();
    expect(irrQualification({ levered: {} }, 'levered')).toBeNull();
  });

  it('qualifies the figure when the guarantee is withdrawn', () => {
    const q = irrQualification(NOT_GUARANTEED, 'levered');
    expect(q).not.toBeNull();
    expect(q.mark).toBe(IRR_MARK);
    expect(q.signChanges).toBe(3);
    expect(q.text).toMatch(new RegExp(IRR_SHORT, 'i'));
    // What it must NOT say. `false` withdraws a guarantee; it does not assert
    // that several rates exist, and every sample deal that trips it has exactly
    // one real IRR. It is also not a fault, so it carries no severity.
    expect(q.text).not.toMatch(/several rates|more than one rate (exists|solves)/i);
    expect(q.text).not.toMatch(/error|invalid|wrong|unreliable|warning/i);
  });

  it('still qualifies when the sign-change count itself is missing', () => {
    const q = irrQualification({ levered: { uniquenessGuaranteed: false, signChanges: null } }, 'levered');
    expect(q).not.toBeNull();
    // No fabricated count.
    expect(q.text).toContain('changes sign more than once');
    expect(q.signChanges).toBeNull();
  });

  it('answers the two series independently', () => {
    const mixed = {
      levered: { uniquenessGuaranteed: false, signChanges: 3 },
      unlevered: { uniquenessGuaranteed: true, signChanges: 1 },
    };
    expect(irrQualification(mixed, 'levered')).not.toBeNull();
    expect(irrQualification(mixed, 'unlevered')).toBeNull();
  });
});

const SCREENS = [
  { name: 'Pipeline', render: () => <Pipeline deals={[healthyDeal()]} onOpen={noop} onExport={noop} /> },
  { name: 'DealModel', render: () => <DealModel deal={healthyDeal()} onChange={noop} posture="form" onPosture={noop} /> },
  { name: 'Waterfall', render: () => <Waterfall deal={promotedDeal()} onChange={noop} /> },
  { name: 'Sensitivity', render: () => <Sensitivity deal={healthyDeal()} /> },
];

describe.each(SCREENS.map((s) => [s.name, s]))('%s surfaces the qualification', (name, screen) => {
  it('marks the IRR when uniqueness is not established', () => {
    mockIrrOverride = NOT_GUARANTEED;
    withScreen(screen.render(), (c) => {
      expect(marks(c).length).toBeGreaterThan(0);
      assertNoImpossibleNumbers(c, `${name} with the IRR guarantee withdrawn`);
    });
  });

  it('does not suppress the IRR it is qualifying', () => {
    mockIrrOverride = NOT_GUARANTEED;
    withScreen(screen.render(), (c) => {
      // A qualification on a number, not an error state: the rate is still on
      // screen at full precision, in its usual place.
      expect(text(c)).toMatch(/\d+\.\d%/);
    });
  });

  it('says nothing when the model guarantees uniqueness', () => {
    mockIrrOverride = GUARANTEED;
    withScreen(screen.render(), (c) => {
      expect(marks(c)).toHaveLength(0);
      expect(text(c)).not.toContain(IRR_FOOTNOTE);
    });
  });

  it('says nothing when the flag is unknown rather than false', () => {
    mockIrrOverride = UNKNOWN;
    withScreen(screen.render(), (c) => {
      expect(marks(c)).toHaveLength(0);
      expect(text(c)).not.toContain(IRR_FOOTNOTE);
    });
  });
});

describe('the qualification is explained where it is used', () => {
  it('footnotes the mark on the Pipeline rather than leaving a bare asterisk', () => {
    mockIrrOverride = NOT_GUARANTEED;
    withScreen(<Pipeline deals={[healthyDeal()]} onOpen={noop} onExport={noop} />, (c) => {
      expect(text(c)).toContain(IRR_FOOTNOTE);
    });
  });

  it('footnotes it on the Deal Model too', () => {
    mockIrrOverride = NOT_GUARANTEED;
    withScreen(<DealModel deal={healthyDeal()} onChange={noop} posture="form" onPosture={noop} />, (c) => {
      expect(text(c)).toContain(IRR_FOOTNOTE);
    });
  });

  it('states on the Sensitivity grid that its cells are not individually tested', () => {
    mockIrrOverride = NOT_GUARANTEED;
    withScreen(<Sensitivity deal={healthyDeal()} />, (c) => {
      // The grid runs dozens of models and hands back only rates, so the per-cell
      // diagnostic is not reachable. Claiming the cells inherit the base case's
      // verdict would be a claim the model never made; saying they are untested
      // is the honest reading.
      expect(text(c)).toMatch(/not\s+individually tested for uniqueness/i);
    });
  });
});

describe('an incomplete model is never qualified', () => {
  it.each(screenCases().filter((c) => c.key === 'clearedHold' || c.key === 'blank').map((c) => [c.label, c.deal]))(
    'renders no IRR mark for %s',
    (_label, deal) => {
      // The real degenerate model, unmocked: irrDiagnostics is {unique: null}
      // on both series, so nothing at all is rendered.
      withScreen(<DealModel deal={deal} onChange={noop} posture="form" onPosture={noop} />, (c) => {
        expect(marks(c)).toHaveLength(0);
      });
      withScreen(<Pipeline deals={[deal]} onOpen={noop} onExport={noop} />, (c) => {
        expect(marks(c)).toHaveLength(0);
      });
    },
  );
});
