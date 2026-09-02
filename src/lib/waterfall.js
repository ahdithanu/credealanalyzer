/**
 * LP/GP distribution waterfall.
 *
 * Takes the equity cash flow series runModel() produces (months[].equityFlow,
 * with the net sale proceeds already folded into the final month) and splits it
 * between the limited partners and the sponsor through the standard tiers:
 *
 *   1. Preferred return on unreturned capital
 *   2. Return of capital
 *   3. GP catch-up (optional)
 *   4. Residual promote, in as many IRR-hurdle tiers as the deal has
 *
 * ─── CONVENTIONS IMPLEMENTED, AND WHY ────────────────────────────────────────
 *
 * PREF ACCRUES ON UNRETURNED CAPITAL, NOT ON CONTRIBUTED CAPITAL.
 *   Once a dollar of capital has been returned it stops earning the pref. The
 *   alternative — accruing on the full contributed amount until the very end —
 *   is a real (if rarer) convention, but pairing it with tier 2 as written here
 *   would pay the LP a preferred return on money it already has back, which
 *   overstates LP proceeds on any deal with interim distributions.
 *
 * UNPAID PREF COMPOUNDS BY DEFAULT.
 *   Pref not paid in a period is added to the accrued balance and itself earns
 *   the pref rate thereafter. This is the LP-favourable market default, and it
 *   is the only convention under which a deal that defers all distributions to
 *   sale gives the LP the same outcome as one that pays currently. Set
 *   `prefCompounding: false` for a simple (non-compounding) pref, which accrues
 *   only on unreturned capital.
 *
 * THE STATED PREF RATE IS AN EFFECTIVE ANNUAL RATE BY DEFAULT.
 *   An "8% pref" compounded monthly at 8%/12 actually yields 8.30% a year. That
 *   gap is 30 bps of LP money per year and it is invisible unless you look for
 *   it, so the default converts the stated rate to its true monthly equivalent
 *   and an 8% pref accrues exactly 8% a year. Deals whose documents say "one
 *   twelfth of the pref rate per month" set `prefRateBasis: 'nominal'`.
 *
 * IRR HURDLES ARE ENFORCED AS ACCRETING BALANCES, NOT BY SOLVING AN IRR.
 *   A tier keyed to "until the LP achieves a 15% IRR" is implemented as a
 *   balance that grows at 15% and is drawn down by every dollar distributed to
 *   investors. That balance is the future value of the LP's flows at 15%, so it
 *   hits zero at exactly the moment the LP's IRR reaches 15% — identical to the
 *   IRR test, but exact and solvable inside a single period, which a root-find
 *   on a partially-known period is not. The balance is allowed to go negative
 *   and keep accreting: an LP that is ahead of the hurdle stays ahead unless
 *   fresh capital is called.
 *
 *   The hurdle's per-period rate is ALWAYS the compounding conversion, never
 *   `prefRateBasis`. An IRR is defined by compounding — `returns.lpIRR` is
 *   `annualize(irr(...))` — so a 15% hurdle converted at 15%/12 a month is
 *   enforced at a 16.08% IRR, and the result object would report `hurdleMet`
 *   true beside an `lpIRR` of 0.1608 against a stated hurdle of 0.15. How the
 *   pref is QUOTED is a drafting convention; what an IRR is, is not.
 *
 * PROMOTE IS CLAWED BACK IF THE INVESTORS END SHORT.
 *   Each tier is unreachable while pref or capital is outstanding, but that
 *   only orders the tiers WITHIN a period: a deal that distributes, pays
 *   promote, and then calls fresh capital can leave the GP promoted on money
 *   the investors never got back. The final period therefore runs a lookback:
 *   the GP returns promote, up to the promote it has received, until the
 *   investor class is whole on capital and accrued pref. It is reported as
 *   `totals.gpClawback`, never silently netted away.
 *
 * GP CO-INVESTMENT IS PARI PASSU.
 *   The sponsor's co-invest dollars sit in the same investor class as the LP's:
 *   same pref, same return of capital, same residual share. Promote is paid to
 *   the GP on top. Because every investor dollar is treated identically, LP IRR
 *   and investor-class IRR coincide, so a hurdle stated on "the LP" is
 *   unambiguous.
 *
 * ─── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * It does not un-net a period. runModel() reports equityFlow as a single netted
 * figure per month, so a construction month with both a capital call and a
 * distribution of in-place income arrives here as one number. Pref therefore
 * accrues on the net call, not the gross one. On the deals this engine models
 * the two coincide (in-place income only appears in renovation deals, which
 * distribute only what is left after interest); a model that ever grossed the
 * two up would need to hand this function both series, not their difference.
 *
 * It does not solve a second IRR. `irr()` and `annualize()` come from
 * finance.js; a waterfall that disagreed with the model about what an IRR is
 * would be worse than useless.
 *
 * It never reports an unknown as zero, or as a definite yes. A GP that
 * contributes no capital and receives only promote has cash flows with no sign
 * change and therefore no IRR; that is reported as null, not as a large number
 * and not as 0. A deal with no capital called has no hurdle to have met, so
 * `hurdleMet` is null there rather than true — the ending hurdle balance is
 * zero only because nothing ever happened.
 */

import { irr, annualize } from './finance';

// Below this, a residual balance is float noise from the period arithmetic
// rather than money anyone would distribute.
const EPS = 1e-9;

export const DEFAULT_WATERFALL = {
  prefRate: 0.08,
  prefCompounding: true,
  prefRateBasis: 'effective',   // 'effective' | 'nominal'
  returnOfCapitalFirst: false,  // true flips tiers 1 and 2
  gpCoInvestShare: 0,           // sponsor's pari passu share of every capital call
  catchUp: {
    enabled: true,
    gpShare: 1.0,               // share of catch-up dollars going to the GP
    targetPromoteShare: null,   // null = catch up to tiers[0].gpShare
  },
  tiers: [{ irrHurdle: null, gpShare: 0.20 }],
  periodsPerYear: 12,
};

/**
 * Convert a stated annual rate to the per-period rate.
 *
 * 'effective' treats the stated rate as the annual outcome and finds the
 * per-period rate that compounds to it; 'nominal' divides. See the header for
 * why 'effective' is the default.
 */
export function periodRate(annualRate, periodsPerYear, basis = 'effective') {
  if (!Number.isFinite(annualRate) || annualRate === 0) return 0;
  return basis === 'nominal'
    ? annualRate / periodsPerYear
    : Math.pow(1 + annualRate, 1 / periodsPerYear) - 1;
}

/**
 * Merge caller config over the defaults and reject structures whose arithmetic
 * has no answer. These throw rather than returning a flag: a malformed tier
 * stack is a programming error in the caller, not a deal that underwrites
 * badly, and silently "fixing" it would put fabricated splits in front of an
 * investment committee.
 */
export function resolveWaterfall(config = {}) {
  const cfg = {
    ...DEFAULT_WATERFALL,
    ...config,
    catchUp: { ...DEFAULT_WATERFALL.catchUp, ...(config.catchUp || {}) },
    tiers: (config.tiers || DEFAULT_WATERFALL.tiers).map((t) => ({ irrHurdle: null, gpShare: 0, ...t })),
  };

  if (!Number.isFinite(cfg.prefRate) || cfg.prefRate < 0) {
    throw new Error('waterfall: prefRate must be a non-negative number');
  }
  if (!Number.isInteger(cfg.periodsPerYear) || cfg.periodsPerYear < 1) {
    throw new Error('waterfall: periodsPerYear must be a positive integer');
  }
  if (!Number.isFinite(cfg.gpCoInvestShare) || cfg.gpCoInvestShare < 0 || cfg.gpCoInvestShare >= 1) {
    throw new Error('waterfall: gpCoInvestShare must be in [0, 1)');
  }
  // Unvalidated, anything that is not the literal 'nominal' selects
  // 'effective', so a capitalisation typo quietly moves 30 bps a year of LP
  // money — the same class of silent repair every other check here rejects.
  if (cfg.prefRateBasis !== 'effective' && cfg.prefRateBasis !== 'nominal') {
    throw new Error("waterfall: prefRateBasis must be 'effective' or 'nominal'");
  }
  if (!cfg.tiers.length) throw new Error('waterfall: at least one residual tier is required');

  let previousHurdle = -Infinity;
  cfg.tiers.forEach((t, i) => {
    if (!Number.isFinite(t.gpShare) || t.gpShare < 0 || t.gpShare >= 1) {
      throw new Error(`waterfall: tier ${i} gpShare must be in [0, 1)`);
    }
    if (t.irrHurdle === null || t.irrHurdle === undefined) {
      if (i !== cfg.tiers.length - 1) {
        throw new Error(`waterfall: only the final tier may omit irrHurdle (tier ${i} does not)`);
      }
      return;
    }
    if (!Number.isFinite(t.irrHurdle) || t.irrHurdle <= -1) {
      throw new Error(`waterfall: tier ${i} irrHurdle must be a rate above -100%`);
    }
    // Out-of-order hurdles would let a later tier's balance clear before an
    // earlier tier's, so distributions would skip a split silently.
    if (t.irrHurdle <= previousHurdle) {
      throw new Error(`waterfall: tier irrHurdle values must strictly increase (tier ${i})`);
    }
    previousHurdle = t.irrHurdle;
  });

  // Every dollar must land in a tier. A stack whose last tier still carries a
  // hurdle is a transcription one line short, and inventing a terminal split
  // for the money above it puts a fabricated promote in front of a committee —
  // and would attribute dollars split above the hurdle to the tier below it.
  const finalHurdle = cfg.tiers[cfg.tiers.length - 1].irrHurdle;
  if (finalHurdle !== null && finalHurdle !== undefined) {
    throw new Error('waterfall: the final tier must be open-ended (irrHurdle null) so every dollar has a split');
  }

  const targetPromote = cfg.catchUp.targetPromoteShare ?? cfg.tiers[0].gpShare;
  if (cfg.catchUp.enabled && targetPromote > 0) {
    if (!Number.isFinite(cfg.catchUp.gpShare) || cfg.catchUp.gpShare > 1) {
      throw new Error('waterfall: catchUp.gpShare must be a number no greater than 1');
    }
    // At or below the promote share the GP's ratio never rises to the target,
    // so the catch-up tier would absorb every dollar for ever.
    if (cfg.catchUp.gpShare <= targetPromote) {
      throw new Error(
        `waterfall: catchUp.gpShare (${cfg.catchUp.gpShare}) must exceed the promote share it catches up to (${targetPromote})`
      );
    }
  }
  cfg.catchUp = { ...cfg.catchUp, targetPromoteShare: targetPromote };
  return cfg;
}

/**
 * Run the waterfall over a per-period equity cash flow series.
 *
 * @param {number[]} equityFlows Negative = capital call, positive = distribution.
 *                               Index 0 is time zero, matching irr() in finance.js.
 * @param {Object} config See DEFAULT_WATERFALL.
 */
export function runWaterfall(equityFlows, config = {}) {
  if (!Array.isArray(equityFlows)) throw new TypeError('waterfall: equityFlows must be an array');
  if (equityFlows.some((f) => !Number.isFinite(f))) {
    throw new TypeError('waterfall: equityFlows must be finite numbers');
  }
  const cfg = resolveWaterfall(config);

  // A simple pref sums rather than compounds, so the per-period rate that
  // accrues exactly the stated rate over a year is the stated rate divided by
  // the periods — the compounding conversion accrues only 7.72% on a stated 8%,
  // silently in the GP's favour. The two bases coincide for a simple pref,
  // which is why the basis only reaches the compounding branch.
  const prefPeriodRate = cfg.prefCompounding
    ? periodRate(cfg.prefRate, cfg.periodsPerYear, cfg.prefRateBasis)
    : cfg.prefRate / cfg.periodsPerYear;
  // Always the compounding conversion: see the header. An IRR hurdle is an IRR,
  // and `returns.lpIRR` annualises by compounding, so any other conversion
  // makes the object report a cleared 15% hurdle beside a 16.08% LP IRR.
  const hurdlePeriodRate = cfg.tiers.map((t) =>
    t.irrHurdle === null || t.irrHurdle === undefined
      ? null
      : periodRate(t.irrHurdle, cfg.periodsPerYear, 'effective')
  );

  const lpShareOfCapital = 1 - cfg.gpCoInvestShare;
  const catchUpTarget = cfg.catchUp.targetPromoteShare;
  // k is the promote-to-investor-profit ratio the catch-up drives toward:
  // GP is caught up when promote = k x investor profit.
  const k = catchUpTarget < 1 ? catchUpTarget / (1 - catchUpTarget) : Infinity;

  let unreturnedCapital = 0;
  let accruedPref = 0;
  let investorProfit = 0;   // cumulative distributions to investors above return of capital
  let gpPromoteTotal = 0;
  const hurdleBalance = cfg.tiers.map(() => 0);

  const periods = [];

  for (let t = 0; t < equityFlows.length; t++) {
    // Accrual happens at the START of each period after time zero, so nothing
    // accrues on capital in the instant it is called and nothing accrues after
    // the final distribution. Accruing at period end would add a phantom
    // period of pref past the sale.
    if (t > 0) {
      if (prefPeriodRate > 0) {
        const base = cfg.prefCompounding ? unreturnedCapital + accruedPref : unreturnedCapital;
        accruedPref += base * prefPeriodRate;
      }
      for (let j = 0; j < hurdleBalance.length; j++) {
        if (hurdlePeriodRate[j] !== null) hurdleBalance[j] *= 1 + hurdlePeriodRate[j];
      }
    }

    const flow = equityFlows[t];
    const contribution = flow < 0 ? -flow : 0;
    const distribution = flow > 0 ? flow : 0;

    unreturnedCapital += contribution;
    for (let j = 0; j < hurdleBalance.length; j++) {
      if (hurdlePeriodRate[j] !== null) hurdleBalance[j] += contribution;
    }

    let investorDistribution = 0;
    const payInvestors = (amount, isProfit) => {
      investorDistribution += amount;
      if (isProfit) investorProfit += amount;
      for (let j = 0; j < hurdleBalance.length; j++) {
        if (hurdlePeriodRate[j] !== null) hurdleBalance[j] -= amount;
      }
    };

    let remaining = distribution;
    let prefPaid = 0;
    let capitalReturned = 0;
    let catchUpPaid = 0;          // the GP's share of catch-up dollars
    let catchUpToInvestors = 0;   // the rest of them, when the catch-up is not 100%
    const residualByTier = cfg.tiers.map(() => 0);
    let gpPromote = 0;

    const payPref = () => {
      const amount = Math.min(remaining, accruedPref);
      if (amount <= 0) return;
      accruedPref -= amount;
      remaining -= amount;
      prefPaid += amount;
      payInvestors(amount, true);
    };
    const payCapital = () => {
      const amount = Math.min(remaining, unreturnedCapital);
      if (amount <= 0) return;
      unreturnedCapital -= amount;
      remaining -= amount;
      capitalReturned += amount;
      payInvestors(amount, false);
    };

    if (cfg.returnOfCapitalFirst) { payCapital(); payPref(); } else { payPref(); payCapital(); }

    // Tier 3 — catch-up. Solved, not iterated: with c the GP's share of
    // catch-up dollars, a gross amount g moves the GP to
    // promote + gc = k(investorProfit + g(1 - c)), so
    // g = (k*investorProfit - promote) / (c - k(1 - c)).
    // resolveWaterfall() guarantees the denominator is positive.
    if (cfg.catchUp.enabled && remaining > EPS && catchUpTarget > 0 && Number.isFinite(k)) {
      const owed = k * investorProfit - gpPromoteTotal;
      if (owed > EPS) {
        const c = cfg.catchUp.gpShare;
        const gross = Math.min(remaining, owed / (c - k * (1 - c)));
        const toGp = gross * c;
        const toInvestors = gross - toGp;
        remaining -= gross;
        catchUpPaid = toGp;
        catchUpToInvestors = toInvestors;
        gpPromote += toGp;
        gpPromoteTotal += toGp;
        if (toInvestors > 0) payInvestors(toInvestors, true);
      }
    }

    // Tier 4 — residual, walking the hurdle stack. A tier absorbs only enough
    // to zero its own hurdle balance; the overflow falls to the next tier in
    // the same period, which is what makes a hurdle crossing mid-period exact.
    for (let j = 0; j < cfg.tiers.length && remaining > EPS; j++) {
      const tier = cfg.tiers[j];
      let gross;
      if (hurdlePeriodRate[j] === null) {
        gross = remaining;
      } else {
        if (hurdleBalance[j] <= EPS) continue;   // hurdle already cleared
        gross = Math.min(remaining, hurdleBalance[j] / (1 - tier.gpShare));
      }
      const toGp = gross * tier.gpShare;
      const toInvestors = gross - toGp;
      remaining -= gross;
      residualByTier[j] += gross;
      gpPromote += toGp;
      gpPromoteTotal += toGp;
      if (toInvestors > 0) payInvestors(toInvestors, true);
    }

    const lpContribution = contribution * lpShareOfCapital;
    const gpContribution = contribution - lpContribution;
    const lpDistribution = investorDistribution * lpShareOfCapital;
    const gpDistribution = (investorDistribution - lpDistribution) + gpPromote;

    periods.push({
      index: t,
      contribution,
      distribution,
      lpContribution,
      gpContribution,
      investorDistribution,
      lpDistribution,
      gpDistribution,
      gpPromote,
      prefPaid,
      capitalReturned,
      catchUpPaid,
      catchUpToInvestors,
      residualByTier,
      residualPaid: residualByTier.reduce((s, x) => s + x, 0),
      unpaidPref: accruedPref,
      unreturnedCapital,
      gpClawback: 0,
      lpFlow: lpDistribution - lpContribution,
      gpFlow: gpDistribution - gpContribution,
    });
  }

  // Lookback clawback. Tier order makes promote unreachable while pref or
  // capital is outstanding WITHIN a period, but a deal that distributes, pays
  // promote and then calls fresh capital leaves the GP promoted on money the
  // investors never got back. The GP returns promote — no more than it received
  // — until the investor class is whole, which is what a promote is a share of.
  const shortfall = accruedPref + unreturnedCapital;
  const gpClawback = Math.min(gpPromoteTotal, Math.max(0, shortfall));
  if (gpClawback > EPS && periods.length > 0) {
    const last = periods[periods.length - 1];
    // Returned promote is money already inside the deal changing hands, so the
    // period's total distribution is untouched and only the split moves.
    const toInvestors = gpClawback;
    const toLp = toInvestors * lpShareOfCapital;
    last.investorDistribution += toInvestors;
    last.lpDistribution += toLp;
    last.gpDistribution += (toInvestors - toLp) - gpClawback;
    last.gpClawback = gpClawback;
    last.lpFlow = last.lpDistribution - last.lpContribution;
    last.gpFlow = last.gpDistribution - last.gpContribution;

    const prefFirst = !cfg.returnOfCapitalFirst;
    let left = gpClawback;
    const applyPref = () => {
      const amount = Math.min(left, accruedPref);
      accruedPref -= amount; left -= amount; last.prefPaid += amount;
    };
    const applyCapital = () => {
      const amount = Math.min(left, unreturnedCapital);
      unreturnedCapital -= amount; left -= amount; last.capitalReturned += amount;
    };
    if (prefFirst) { applyPref(); applyCapital(); } else { applyCapital(); applyPref(); }
    last.unpaidPref = accruedPref;
    last.unreturnedCapital = unreturnedCapital;
  }

  return summarize(periods, cfg, {
    unreturnedCapital, accruedPref, hurdleBalance, hurdlePeriodRate, gpClawback,
  });
}

function summarize(periods, cfg, ending) {
  const sum = (key) => periods.reduce((s, p) => s + p[key], 0);

  const lpFlows = periods.map((p) => p.lpFlow);
  const gpFlows = periods.map((p) => p.gpFlow);

  const lpContributions = sum('lpContribution');
  const gpContributions = sum('gpContribution');
  const lpDistributions = sum('lpDistribution');
  const gpDistributions = sum('gpDistribution');
  const gpPromote = sum('gpPromote');
  const totalDistributions = sum('distribution');
  const totalContributions = sum('contribution');
  const totalProfit = totalDistributions - totalContributions;

  // A multiple needs a denominator; an IRR needs a sign change. Where either is
  // missing the answer is unknown, and unknown is null — format.js renders it
  // 'n/a'. A GP that funds no capital has no multiple and no IRR however large
  // its promote, and reporting 0 there would be a lie in the opposite
  // direction from reporting a huge number.
  const multiple = (dist, contrib) => (contrib > EPS ? dist / contrib : null);

  const residualByTier = cfg.tiers.map((_, j) =>
    periods.reduce((s, p) => s + p.residualByTier[j], 0)
  );

  return {
    config: cfg,
    periods,
    totals: {
      contributions: totalContributions,
      distributions: totalDistributions,
      lpContributions,
      gpContributions,
      lpDistributions,
      gpDistributions,
      gpPromote,
      prefPaid: sum('prefPaid'),
      capitalReturned: sum('capitalReturned'),
      catchUpPaid: sum('catchUpPaid'),
      catchUpToInvestors: sum('catchUpToInvestors'),
      gpClawback: ending.gpClawback,
      // What the GP keeps. Reported beside the gross promote rather than in
      // place of it: a promote that was earned and then returned is a different
      // fact about a deal from a promote that was never earned.
      gpPromoteNet: gpPromote - ending.gpClawback,
      residualByTier,
      unpaidPref: ending.accruedPref,
      unreturnedCapital: ending.unreturnedCapital,
    },
    tiers: cfg.tiers.map((t, j) => ({
      irrHurdle: t.irrHurdle ?? null,
      gpShare: t.gpShare,
      distributed: residualByTier[j],
      // A tier with no hurdle is never "met"; it is the terminal split. And a
      // deal with no capital called has no hurdle to have met: the balance is
      // zero because nothing happened, which is unknown, not achieved.
      hurdleMet: ending.hurdlePeriodRate[j] === null || totalContributions <= EPS
        ? null
        : ending.hurdleBalance[j] <= EPS,
    })),
    returns: {
      lpIRR: annualize(irr(lpFlows), cfg.periodsPerYear),
      gpIRR: annualize(irr(gpFlows), cfg.periodsPerYear),
      lpEquityMultiple: multiple(lpDistributions, lpContributions),
      gpEquityMultiple: multiple(gpDistributions, gpContributions),
      lpProfit: lpDistributions - lpContributions,
      gpProfit: gpDistributions - gpContributions,
      gpPromoteShareOfProfit:
        totalProfit > EPS ? (gpPromote - ending.gpClawback) / totalProfit : null,
      // What the LP is still owed if the deal stopped here. Both are 0 on a
      // deal that cleared its pref and returned capital.
      prefShortfall: ending.accruedPref,
      capitalShortfall: ending.unreturnedCapital,
    },
    lpFlows,
    gpFlows,
  };
}

/**
 * Run the waterfall against a runModel() result.
 *
 * The GP co-invest share defaults to the one the model already used to split
 * financing.gpCoInvest out of the equity commitment — a waterfall that assumed
 * a different capital stack from the model feeding it would reconcile to
 * nothing.
 */
export function waterfallFromModel(model, config = {}) {
  if (!model || !Array.isArray(model.months)) {
    throw new TypeError('waterfall: expected a runModel() result');
  }
  const commitment = model.financing?.equityCommitment ?? 0;
  const impliedCoInvest =
    commitment > 0 ? (model.financing?.gpCoInvest ?? 0) / commitment : 0;

  return runWaterfall(model.months.map((m) => m.equityFlow), {
    periodsPerYear: 12,
    gpCoInvestShare: impliedCoInvest,
    ...config,
  });
}
