/**
 * The deals every screen is rendered against.
 *
 * Four kinds, from the brief the suite exists to satisfy:
 *
 *  (a) a healthy model from the sample portfolio;
 *  (b) an incomplete model, where runModel() takes its degenerate path and most
 *      of the model is null — INCLUDING financing.equityCommitment and
 *      loanCommitment, which several screens divide by, and `null / 5e6` is 0 in
 *      JavaScript rather than NaN, so an unguarded share renders as a confident
 *      0.0% rather than as an absence;
 *  (c) a deal carrying a promote structure, and one carrying a structure
 *      resolveWaterfall() refuses;
 *  (d) a blank deal exactly as the New deal button makes it.
 *
 * Deliberately NO exact engine figures anywhere in this module or the suite that
 * uses it. finance.js is under active change; what is pinned here is the SHAPE of
 * each case, and what the tests assert is the contract — an absence renders as an
 * absence, no impossible number reaches the DOM, a null never reads as a pass.
 */

import { calculateMetrics } from '../../lib/finance';
import { SAMPLE_DEALS } from '../../lib/sampleDeals';
import { blankDeal } from '../../App';

/** Screens read `deal.metrics.model`, so a case is a deal with metrics attached. */
export const withMetrics = (deal) => ({ ...deal, metrics: calculateMetrics(deal) });

/** A promote structure resolveWaterfall() accepts: open-ended at the top. */
export const RUNNABLE_PROMOTE = {
  prefRate: 0.08,
  prefCompounding: true,
  prefRateBasis: 'effective',
  returnOfCapitalFirst: false,
  catchUp: { enabled: true, gpShare: 0.5, targetPromoteShare: null },
  tiers: [{ irrHurdle: 0.15, gpShare: 0.2 }, { irrHurdle: null, gpShare: 0.3 }],
};

/**
 * A structure resolveWaterfall() rejects: the stack does not end open-ended, so
 * every dollar above the last hurdle has no split. This is a state an analyst
 * passes through while typing a tier stack, it reaches disk, and every screen
 * has to survive it.
 */
export const UNRUNNABLE_PROMOTE = { tiers: [{ irrHurdle: 0.15, gpShare: 0.2 }] };

const healthy = () => ({ ...SAMPLE_DEALS[0] });

/**
 * The cases, as `{ key, label, deal }`. `deal` is a fresh object per call so a
 * test that mutates one cannot leak into the next.
 */
export function screenCases() {
  return [
    {
      key: 'healthy',
      label: 'a healthy sample deal',
      deal: withMetrics(healthy()),
    },
    {
      key: 'clearedHold',
      label: 'an incomplete model (hold period cleared to 0)',
      // The keystroke that once white-screened the whole application: the model
      // reports a construction period with an empty months array.
      deal: withMetrics({ ...healthy(), holdPeriod: 0 }),
    },
    {
      key: 'noBasis',
      label: 'an incomplete model (no purchase price and no construction cost)',
      deal: withMetrics({
        ...healthy(),
        purchasePrice: 0,
        constructionCost: 0,
        ffe: 0,
        financingCosts: 0,
      }),
    },
    {
      key: 'promoted',
      label: 'a deal with a configured promote structure',
      deal: withMetrics({ ...healthy(), waterfall: RUNNABLE_PROMOTE }),
    },
    {
      key: 'rejectedPromote',
      label: 'a deal whose promote structure the waterfall refuses',
      deal: withMetrics({ ...healthy(), waterfall: UNRUNNABLE_PROMOTE }),
    },
    {
      key: 'rejectedPromoteIncomplete',
      label: 'a refused promote structure on an incomplete model',
      deal: withMetrics({ ...healthy(), holdPeriod: 0, waterfall: UNRUNNABLE_PROMOTE }),
    },
    {
      key: 'sizedToCreditBox',
      label: 'a deal sized to the credit box',
      // The debt sizer runs a fixed point and reports its own constraints; the
      // Deal Model's sizing panel reads a different set of fields on this path.
      deal: withMetrics({ ...healthy(), sizeDebtToConstraints: true }),
    },
    {
      key: 'sizedIncomplete',
      label: 'a deal sized to the credit box with nothing to size against',
      deal: withMetrics({ ...healthy(), sizeDebtToConstraints: true, holdPeriod: 0 }),
    },
    {
      key: 'unusableCoInvest',
      label: 'a complete model whose co-invest share is not a number',
      // A null INSIDE an otherwise complete model, which the incomplete cases
      // cannot produce: finance.js reports gpCoInvest and lpEquity as null while
      // the total project cost beside them is a real number. `null / total` is 0
      // in JavaScript, so this is the case where an unguarded share prints a
      // confident 0.0% next to an amount reading n/a. A stored deal can carry
      // this: storage.js hands back what was written, byte for byte.
      deal: withMetrics({ ...healthy(), gpCoInvestShare: 'not a number' }),
    },
    {
      key: 'blank',
      label: 'a blank deal straight from blankDeal()',
      deal: withMetrics(blankDeal()),
    },
  ];
}

/** The cases whose model took runModel()'s degenerate path. */
export const INCOMPLETE_KEYS = [
  'clearedHold', 'noBasis', 'rejectedPromoteIncomplete', 'sizedIncomplete', 'blank',
];
