/**
 * The Pipeline header states a portfolio figure. This pins what it is allowed
 * to claim when it cannot measure every row.
 *
 * The gap these close was found by mutation testing, not by reading: the
 * roll-up weighted `(r.irr ?? 0)`, so a deal whose IRR the engine could not
 * solve entered the average at exactly 0% and dragged the headline down. One
 * unmodelled deal beside one good one reported 3.4% against the good deal's
 * 22.1%. The existing absence test could not see it, because it built its
 * portfolio entirely from incomplete cases — every equity was null, the total
 * was zero, and the ternary short-circuited before the `?? 0` could ever run.
 * A mixed portfolio is the only shape that reaches the bug, and nothing
 * rendered one against this assertion.
 */

import React from 'react';

import Pipeline from '../Pipeline';
import Sensitivity from '../Sensitivity';
import { DEFAULT_COVENANTS } from '../../lib/validation';
import { NA, mult } from '../../lib/format';
import { renderScreen, withScreen, text } from '../testing/renderScreen';
import { withMetrics } from '../testing/cases';
import { SAMPLE_DEALS } from '../../lib/sampleDeals';
import { runModel } from '../../lib/finance';

const noop = () => {};
const pipeline = (deals) => (
  <Pipeline deals={deals} onOpen={noop} onNew={noop} onDelete={noop} />
);

/** A deal the engine prices, and one it cannot, with a real equity number. */
const solvable = () => withMetrics(SAMPLE_DEALS[0]);
const unsolvable = () => withMetrics({ ...SAMPLE_DEALS[0], grossRevenue: 1 });

describe('the portfolio roll-up never treats an unknown as a zero', () => {
  it('an unsolved IRR is excluded from the weighted average, not averaged in as 0%', () => {
    const good = solvable();
    const goodModel = runModel(good);
    expect(goodModel.returns.leveredIRR).toEqual(expect.any(Number));

    const bad = unsolvable();
    const badModel = runModel(bad);
    // The shape that reaches the bug: no IRR, but a real equity weight.
    expect(badModel.returns.leveredIRR).toBeNull();
    expect(badModel.returns.peakEquity).toEqual(expect.any(Number));

    const alone = renderScreen(pipeline([good]));
    const mixed = renderScreen(pipeline([good, bad]));
    try {
      const irrOf = (c) => text(c).match(/Weighted IRR\s*(-?[\d.]+)%/);
      const a = irrOf(alone.container);
      const b = irrOf(mixed.container);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      // Adding a deal the engine could not price must not move the average of
      // the deals it could. Diluting it toward zero is the fabrication.
      expect(Number(b[1])).toBeCloseTo(Number(a[1]), 1);
    } finally {
      alone.unmount();
      mixed.unmount();
    }
  });

  it('says so when the average covers fewer rows than are on screen', () => {
    withScreen(pipeline([solvable(), unsolvable()]), (c) => {
      expect(text(c)).toMatch(/Weighted IRR[\s\S]{0,40}\(1 of 2\)/);
    });
  });

  it('reports unmodelled equity as an absence rather than $0 deployed', () => {
    // "$0 of capital deployed" is a measurement. The portfolio has not been
    // measured — the cell beside it concedes exactly that.
    withScreen(pipeline([withMetrics({ ...SAMPLE_DEALS[0], holdPeriod: 0 })]), (c) => {
      const body = text(c);
      expect(body).toMatch(new RegExp(`Equity deployed\\s*${NA}`));
      expect(body).not.toMatch(/Equity deployed\s*\$0(?!\.)/);
    });
  });
});

describe('the covenants the pipeline colours against are the firm\'s, not literals', () => {
  it('tones a DSCR breach against DEFAULT_COVENANTS, and stops if the covenant moves', () => {
    // Mutation M17 put `MIN_DSCR = 0` back and the whole suite stayed green,
    // so a regression that silently stopped flagging coverage breaches on the
    // pipeline would have shipped. This is the test that was missing.
    const deals = SAMPLE_DEALS.map(withMetrics);
    const breaching = deals.filter((d) => {
      const dscr = runModel(d).operating.minStabilizedDSCR;
      return Number.isFinite(dscr) && dscr < DEFAULT_COVENANTS.minDSCR;
    });
    // The fixture has to actually exercise the branch, or this proves nothing.
    expect(breaching.length).toBeGreaterThan(0);

    withScreen(pipeline(deals), (c) => {
      const toned = c.querySelectorAll('td .neg, td.neg');
      expect(toned.length).toBeGreaterThan(0);
    });

    // And it must be the covenant that decides, not a literal that happens to
    // equal it today. Pin the SET, not just that something was toned: exactly
    // the visible rows whose coverage is below DEFAULT_COVENANTS.minDSCR carry
    // the negative tone. Move the covenant without moving the screen and this
    // fails, instead of shipping a pipeline colouring against a floor the firm
    // no longer holds. (The default saved view hides closed deals, so the
    // expectation is computed over what is actually on screen.)
    withScreen(pipeline(deals), (c) => {
      const dscrIdx = [...c.querySelectorAll('thead th')]
        .findIndex((th) => th.textContent.trim() === 'DSCR');
      expect(dscrIdx).toBeGreaterThan(-1);

      const visible = [...c.querySelectorAll('tbody tr')].map((tr) => {
        const cells = [...tr.querySelectorAll('td')];
        return { name: cells[0].textContent, cell: cells[dscrIdx] };
      });
      expect(visible.length).toBeGreaterThan(0);

      const expected = visible
        .filter(({ name }) => {
          const deal = deals.find((d) => name.includes(d.name));
          const dscr = runModel(deal).operating.minStabilizedDSCR;
          return dscr !== null && dscr < DEFAULT_COVENANTS.minDSCR;
        })
        .map(({ name }) => name)
        .sort();

      const toned = visible
        .filter(({ cell }) => cell.className.split(/\s+/).includes('neg'))
        .map(({ name }) => name)
        .sort();

      expect(toned).toEqual(expected);
      // The branch has to actually fire, or this proves nothing.
      expect(toned.length).toBeGreaterThan(0);
    });
  });
});

describe("the breakeven panel solves against the firm's covenants, not literals", () => {
  // Mutation M14 moved DEFAULT_COVENANTS.minDevSpreadBps from 100 to 150 AND
  // put the literal `100 bps` back in Sensitivity.js, together, and the whole
  // suite stayed green — the screen would have gone on solving and labelling a
  // breakeven against a covenant the firm no longer holds. Reading the label
  // back off the covenant is what closes that.
  it('labels each breakeven with the covenant it was actually solved against', () => {
    const deal = withMetrics(SAMPLE_DEALS[0]);
    withScreen(<Sensitivity deal={deal} />, (c) => {
      const body = text(c);
      expect(body).toContain(`${DEFAULT_COVENANTS.minDevSpreadBps} bps spread`);
      expect(body).toContain(`${mult(DEFAULT_COVENANTS.minDSCR)} stabilized DSCR`);
    });
  });
});
