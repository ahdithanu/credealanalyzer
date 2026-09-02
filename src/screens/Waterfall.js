import React, { useMemo, useState } from 'react';
import { Plus, AlertTriangle } from 'lucide-react';
import { runModel } from '../lib/finance';
import { waterfallFromModel, DEFAULT_WATERFALL } from '../lib/waterfall';
import { Panel, MetricStrip, Seg } from '../ui/components';
import { money, money0, pct, mult, NA } from '../lib/format';

// Same threshold waterfall.js settles its own tiers at: below this a residual
// balance is float noise from the period arithmetic, not money anyone is owed.
const EPS = 1e-9;

/**
 * Accounting parentheses. This screen reads as a distribution statement, and a
 * loss on one of those is (1,234) — a leading minus is easy to lose in a column
 * and easy to mistake for a hyphen.
 */
const dollars = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  return n < 0 ? `(${money0(-n)})` : money0(n);
};

/** The same convention compacted, for the strip, where a column has no width. */
const brief = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  return n < 0 ? `(${money(-n)})` : money(n);
};

const negClass = (n) => (Number.isFinite(n) && n < 0 ? 'neg' : '');

/**
 * A promote or catch-up share, at the precision it is actually applied at.
 * Rounding 22.5% to 23% states a split the engine is not using.
 */
const splitPct = (share) => {
  if (share === null || share === undefined || !Number.isFinite(share)) return NA;
  const whole = Math.abs(share * 100 - Math.round(share * 100)) < 1e-9;
  return pct(share, whole ? 0 : 1);
};

/** What a nominal-basis pref actually yields once compounded monthly. */
const nominalYield = (rate) =>
  Number.isFinite(rate) ? Math.pow(1 + rate / 12, 12) - 1 : null;

/** Percent inputs round-trip through a rate; 0.08 * 100 is not exactly 8. */
const asPercent = (rate) =>
  rate === null || rate === undefined || !Number.isFinite(rate) ? '' : Number((rate * 100).toFixed(4));

/**
 * The starting structure is the module's own default, deep-copied so that
 * editing a tier on screen can never mutate the shared DEFAULT_WATERFALL that
 * every other caller reads.
 *
 * gpCoInvestShare and periodsPerYear are deliberately absent: waterfallFromModel
 * derives the co-invest from the capital stack the model actually funded, and a
 * waterfall run on a different stack from the model feeding it reconciles to
 * nothing.
 */
const initialStructure = () => ({
  prefRate: DEFAULT_WATERFALL.prefRate,
  prefCompounding: DEFAULT_WATERFALL.prefCompounding,
  prefRateBasis: DEFAULT_WATERFALL.prefRateBasis,
  returnOfCapitalFirst: DEFAULT_WATERFALL.returnOfCapitalFirst,
  catchUp: { ...DEFAULT_WATERFALL.catchUp },
  tiers: DEFAULT_WATERFALL.tiers.map((t) => ({ ...t })),
});

export default function Waterfall({ deal }) {
  const [cfg, setCfg] = useState(initialStructure);

  const model = useMemo(() => runModel(deal), [deal]);

  // resolveWaterfall() throws on a structure whose arithmetic has no answer,
  // and an analyst editing a tier stack passes through those states on the way
  // to a valid one — clearing a hurdle before retyping it, dropping a promote
  // below the catch-up that feeds it. The throw is the module refusing to
  // fabricate a split, so it is caught and shown, not suppressed.
  const { result, error } = useMemo(() => {
    try {
      return { result: waterfallFromModel(model, cfg), error: null };
    } catch (e) {
      return { result: null, error: String(e.message).replace(/^waterfall:\s*/, '') };
    }
  }, [model, cfg]);

  const commitment = model.financing.equityCommitment;
  // With no schedule the model funded no capital stack, so there is no share to
  // derive from it and the arithmetic returns a confident 0.0% for a deal whose
  // configured co-invest is 20%. The deal's own share is the honest fallback —
  // it is where finance.js reads it from in the first place.
  const coInvestShare = result
    ? result.config.gpCoInvestShare
    : commitment > 0 && model.financing.gpCoInvest > 0
      ? model.financing.gpCoInvest / commitment
      : (deal.gpCoInvestShare ?? 0.20);

  const setTier = (i, patch) =>
    setCfg((c) => ({ ...c, tiers: c.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));

  const removeTier = (i) =>
    setCfg((c) => ({ ...c, tiers: c.tiers.filter((_, j) => j !== i) }));

  // A new hurdle has to sit strictly above the one below it, and the stack has
  // to stay open-ended at the top, so the tier is inserted beneath the terminal
  // one and seeded off the highest hurdle already in the stack.
  const addTier = () =>
    setCfg((c) => {
      const tiers = c.tiers.map((t) => ({ ...t }));
      const terminal = tiers[tiers.length - 1];
      const prior = tiers.length > 1 ? tiers[tiers.length - 2].irrHurdle : null;
      const floor = Number.isFinite(prior) ? prior : Number.isFinite(c.prefRate) ? c.prefRate : 0;
      tiers.splice(tiers.length - 1, 0, { irrHurdle: floor + 0.04, gpShare: terminal.gpShare });
      terminal.gpShare = Math.min(0.9, terminal.gpShare + 0.1);
      return { ...c, tiers };
    });

  const noFlows = !model.months.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', height: '100%' }}>
      <StructureBand
        cfg={cfg}
        setCfg={setCfg}
        setTier={setTier}
        addTier={addTier}
        removeTier={removeTier}
        coInvestShare={coInvestShare}
        resolvedCatchUpTarget={result?.config.catchUp.targetPromoteShare ?? null}
      />

      {error ? (
        <Callout
          tone="neg"
          title="This promote structure has no arithmetic"
          detail={`${error}. Nothing is shown below because the alternative is a fabricated split.`}
        />
      ) : noFlows ? (
        <Callout
          tone="warn"
          title="No equity cash flow to split"
          detail="The model has no month schedule for this deal, so there are no contributions or distributions to run through the waterfall. Complete the deal inputs on the Deal Model screen."
        />
      ) : (
        <Outcome result={result} model={model} />
      )}
    </div>
  );
}

/* ── structure ──────────────────────────────────────────────────────────── */

function StructureBand({ cfg, setCfg, setTier, addTier, removeTier, coInvestShare, resolvedCatchUpTarget }) {
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setCatchUp = (patch) => setCfg((c) => ({ ...c, catchUp: { ...c.catchUp, ...patch } }));
  // The catch-up target follows tier 1's promote unless it is set outright, so
  // the field shows what the module resolved rather than the null behind it.
  const target = resolvedCatchUpTarget ?? cfg.catchUp.targetPromoteShare ?? cfg.tiers[0]?.gpShare ?? null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <span className="lbl">Promote structure</span>
        <span className="spacer" />
        <span
          className="chip"
          title="Inherited from the capital stack the model funded, set on the Deal Model financing tab. The sponsor's co-invest sits pari passu with the LP: same pref, same return of capital, same residual share."
        >
          GP co-invest {pct(coInvestShare, 1)}
        </span>
        <span className="chip" title="The model reports equity flows monthly, so the waterfall accrues monthly.">
          monthly accrual
        </span>
        <button className="btn ghost" onClick={() => setCfg(initialStructure())}>Reset</button>
      </div>

      <div
        className="panel-bd"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0,1fr))', gap: '14px' }}
      >
        <div className="field">
          <label>Preferred return <span className="dim2">(%)</span></label>
          <input
            className="inp"
            type="number"
            step="0.25"
            value={asPercent(cfg.prefRate)}
            onChange={(e) => set({ prefRate: e.target.value === '' ? null : Number(e.target.value) / 100 })}
          />
          <span className="note">on unreturned capital</span>
        </div>

        <div className="field">
          <label>Rate basis</label>
          {/* waterfall.js applies the basis only on the COMPOUNDING branch: a
              simple pref divides the stated rate by the periods either way. The
              control was left live and its note asserted a 30 bps consequence
              that does not occur, while the tier table below labelled the pref
              with a conversion the engine never performed. */}
          <select
            className="inp"
            disabled={!cfg.prefCompounding}
            value={cfg.prefRateBasis}
            onChange={(e) => set({ prefRateBasis: e.target.value })}
          >
            <option value="effective">Effective annual</option>
            <option value="nominal">Nominal ÷ 12</option>
          </select>
          <span className="note">
            {!cfg.prefCompounding
              ? 'no effect on a simple pref'
              : cfg.prefRateBasis === 'effective'
                ? 'accrues exactly the stated rate a year'
                : `one twelfth a month · a ${pct(cfg.prefRate, 0)} pref yields ${pct(nominalYield(cfg.prefRate), 2)}`}
          </span>
        </div>

        <div className="field">
          <label>Unpaid pref</label>
          <Seg
            options={[{ value: true, label: 'Compounds' }, { value: false, label: 'Simple' }]}
            value={cfg.prefCompounding}
            onChange={(v) => set({ prefCompounding: v })}
          />
          <span className="note">
            {cfg.prefCompounding
              ? 'deferring distributions costs the LP nothing'
              : 'accrues on unreturned capital only'}
          </span>
        </div>

        <div className="field">
          <label>Tier order</label>
          <Seg
            options={[{ value: false, label: 'Pref first' }, { value: true, label: 'Capital first' }]}
            value={cfg.returnOfCapitalFirst}
            onChange={(v) => set({ returnOfCapitalFirst: v })}
          />
          <span className="note">{cfg.returnOfCapitalFirst ? 'capital, then accrued pref' : 'accrued pref, then capital'}</span>
        </div>

        <div className="field">
          <label>GP catch-up</label>
          <Seg
            options={[{ value: true, label: 'On' }, { value: false, label: 'Off' }]}
            value={cfg.catchUp.enabled}
            onChange={(v) => setCatchUp({ enabled: v })}
          />
          <span className="note">{cfg.catchUp.enabled ? `to a ${splitPct(target)} promote` : 'promote starts at tier 1'}</span>
        </div>

        <div className="field">
          <label>Catch-up to GP <span className="dim2">(%)</span></label>
          <input
            className="inp"
            type="number"
            step="5"
            disabled={!cfg.catchUp.enabled}
            value={asPercent(cfg.catchUp.gpShare)}
            onChange={(e) => setCatchUp({ gpShare: e.target.value === '' ? null : Number(e.target.value) / 100 })}
          />
          <span className="note">share of catch-up dollars</span>
        </div>
      </div>

      <div className="panel-bd" style={{ paddingTop: 0 }}>
        <span className="lbl">Tier stack</span>
        <div className="tier-stack" style={{ marginTop: '8px' }}>
          {cfg.tiers.map((tier, i) => {
            const terminal = i === cfg.tiers.length - 1;
            return (
              <div className={`tier-card ${terminal ? 'term' : ''}`} key={i}>
                <div className="tier-hd">
                  <span className="tier-n">{terminal ? 'Residual' : `Tier ${i + 1}`}</span>
                  {!terminal && (
                    <button className="tier-x" title="Remove this tier" onClick={() => removeTier(i)}>×</button>
                  )}
                </div>
                <div className="field">
                  <label>LP IRR hurdle <span className="dim2">(%)</span></label>
                  {terminal ? (
                    <span
                      className="dim2 tier-open"
                      title="The stack must end open-ended so every dollar above the last hurdle has a split."
                    >
                      above every hurdle
                    </span>
                  ) : (
                    <input
                      className="inp"
                      type="number"
                      step="0.5"
                      value={asPercent(tier.irrHurdle)}
                      onChange={(e) =>
                        setTier(i, { irrHurdle: e.target.value === '' ? null : Number(e.target.value) / 100 })
                      }
                    />
                  )}
                </div>
                <div className="field">
                  <label>GP promote <span className="dim2">(%)</span></label>
                  <input
                    className="inp"
                    type="number"
                    step="5"
                    value={asPercent(tier.gpShare)}
                    onChange={(e) =>
                      setTier(i, { gpShare: e.target.value === '' ? null : Number(e.target.value) / 100 })
                    }
                  />
                </div>
              </div>
            );
          })}
          <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={addTier}>
            <Plus size={13} /> Hurdle tier
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── outcome ────────────────────────────────────────────────────────────── */

function Outcome({ result, model }) {
  const { totals, returns, tiers, config } = result;
  const profit = totals.distributions - totals.contributions;
  const shortfall = returns.capitalShortfall > EPS || returns.prefShortfall > EPS;
  const firstHurdle = tiers.find((t) => t.irrHurdle !== null) ?? null;

  const hurdleWord = (met) => (met === null ? 'not measured' : met ? 'cleared' : 'not cleared');

  const metrics = [
    {
      k: 'LP IRR',
      v: pct(returns.lpIRR),
      n: firstHurdle
        ? `${pct(firstHurdle.irrHurdle, 1)} hurdle ${hurdleWord(firstHurdle.hurdleMet)}`
        : `${pct(config.prefRate, 1)} pref, no hurdle above it`,
    },
    {
      k: 'LP multiple',
      v: mult(returns.lpEquityMultiple),
      n: `${brief(totals.lpDistributions)} on ${brief(totals.lpContributions)}`,
    },
    {
      k: 'To LP',
      v: brief(totals.lpDistributions),
      n: `profit ${brief(returns.lpProfit)}`,
      tone: negClass(returns.lpProfit),
    },
    {
      k: 'To GP',
      v: brief(totals.gpDistributions),
      n: `${brief(totals.gpDistributions - totals.gpPromoteNet)} co-invest + ${brief(totals.gpPromoteNet)} promote`,
    },
    {
      k: 'GP promote, net',
      v: brief(totals.gpPromoteNet),
      n: totals.gpClawback > EPS
        ? `${brief(totals.gpPromote)} earned less ${brief(totals.gpClawback)} clawed back`
        : totals.gpPromote > EPS ? 'none clawed back' : 'no promote earned',
      tone: totals.gpClawback > EPS ? 'warnc' : '',
    },
    {
      // The honest headline for sponsor economics, and the reason it sits
      // beside GP IRR rather than beneath it — see the note under the split.
      k: 'Promote ÷ profit',
      v: pct(returns.gpPromoteShareOfProfit),
      n: returns.gpPromoteShareOfProfit === null
        ? 'no profit to share'
        : `of ${brief(profit)} total profit`,
      tone: 'acc',
    },
    {
      k: 'GP IRR',
      v: pct(returns.gpIRR),
      // Two different facts reach this cell as null, and they are opposites.
      // A sponsor that funds nothing has no IRR because it risked nothing; a
      // sponsor wiped out has no IRR because its flows never change sign and no
      // rate solves them. Branching on gpIRR alone printed "no capital at risk"
      // directly above a table showing millions of GP contributions lost — an
      // inverted alignment fact in the one scenario where alignment matters.
      n: totals.gpContributions <= EPS
        ? 'no capital at risk'
        : returns.gpIRR === null
          ? `no solvable IRR on ${brief(totals.gpContributions)} contributed`
          : `on ${brief(totals.gpContributions)} of co-invest`,
      tone: totals.gpContributions > EPS && returns.gpIRR === null ? 'warnc' : '',
    },
  ];

  return (
    <>
      <MetricStrip items={metrics} />

      <div style={{ display: 'grid', gridTemplateColumns: '1.45fr 1fr', gap: '12px', flex: 1, minHeight: 0 }}>
        <Panel
          title="Distribution tiers"
          right={<span className="dim" style={{ fontSize: '11px' }}>{brief(totals.distributions)} distributed · {result.periods.length} monthly periods</span>}
          flush
          style={{ overflow: 'auto', minHeight: 0 }}
        >
          <TierTable result={result} />
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, overflow: 'auto' }}>
          {shortfall && (
            <Callout
              tone="neg"
              title="Investors are not whole"
              detail={
                `${dollars(returns.capitalShortfall)} of capital and ${dollars(returns.prefShortfall)} of accrued preferred return are still outstanding at sale. ` +
                'There is no promote on a deal that does not return the investors their capital, so the tier table shows where the money ran out.' +
                // A reader looking at positive LP profit beside this needs the
                // bridge: pref is paid before capital, so a deal can distribute
                // more than it called and still leave capital outstanding. That
                // is what an LP IRR below the pref rate looks like in dollars.
                (profit > EPS
                  ? ` The LP still cleared ${brief(returns.lpProfit)} of cash profit — distributions went to accrued pref before capital, and an LP IRR of ${pct(returns.lpIRR)} against a pref of ${pct(config.prefRate, 1)} is exactly that gap.`
                  : '') +
                (totals.gpClawback > EPS
                  ? ` The GP returned ${dollars(totals.gpClawback)} of promote it had already been paid; ${dollars(totals.gpPromoteNet)} of promote remains.`
                  : '')
              }
            />
          )}
          <SplitPanel result={result} model={model} />
        </div>
      </div>
    </>
  );
}

/**
 * What each tier paid, which is a different question from what each tier's
 * split says. "The promote is 20%" and "the GP received $2.4M" are answered in
 * different columns here on purpose.
 */
function TierTable({ result }) {
  const { totals, tiers, config } = result;
  const rows = [];

  // The basis is only named when the engine used it. A simple pref accrues the
  // stated rate over twelve periods on either basis, so printing "nominal"
  // there asserts a conversion that did not happen.
  const prefLabel = config.prefCompounding
    ? `${pct(config.prefRate, 2)} ${config.prefRateBasis === 'nominal' ? 'nominal' : 'effective'}, compounding`
    : `${pct(config.prefRate, 2)} simple`;
  const pref = {
    key: 'pref',
    label: 'Preferred return',
    sub: prefLabel,
    hurdle: pct(config.prefRate, 2),
    hurdleSub: totals.unpaidPref > EPS ? `${dollars(totals.unpaidPref)} unpaid` : 'paid in full',
    hurdleTone: totals.unpaidPref > EPS ? 'neg' : 'dim2',
    split: null,
    investors: totals.prefPaid,
    gp: null,
  };
  const capital = {
    key: 'capital',
    label: 'Return of capital',
    sub: `${dollars(totals.contributions)} called`,
    hurdle: null,
    hurdleSub: totals.unreturnedCapital > EPS ? `${dollars(totals.unreturnedCapital)} unreturned` : 'returned in full',
    hurdleTone: totals.unreturnedCapital > EPS ? 'neg' : 'dim2',
    split: null,
    investors: totals.capitalReturned,
    gp: null,
  };
  rows.push(...(config.returnOfCapitalFirst ? [capital, pref] : [pref, capital]));

  if (config.catchUp.enabled && config.catchUp.targetPromoteShare > 0) {
    rows.push({
      key: 'catchup',
      label: 'GP catch-up',
      sub: `to a ${splitPct(config.catchUp.targetPromoteShare)} promote`,
      hurdle: null,
      hurdleSub: totals.catchUpPaid > EPS ? 'reached' : 'not reached',
      hurdleTone: 'dim2',
      split: config.catchUp.gpShare,
      investors: totals.catchUpToInvestors,
      gp: totals.catchUpPaid,
    });
  }

  tiers.forEach((t, j) => {
    const gross = t.distributed;
    const promote = gross * t.gpShare;
    const prior = j > 0 ? tiers[j - 1].irrHurdle : null;
    rows.push({
      key: `tier-${j}`,
      label: t.irrHurdle === null ? 'Residual split' : `Tier ${j + 1}`,
      sub: t.irrHurdle === null
        ? prior === null ? 'every residual dollar' : `above a ${pct(prior, 1)} LP IRR`
        : `${splitPct(t.gpShare)} promote to a ${pct(t.irrHurdle, 1)} LP IRR`,
      hurdle: t.irrHurdle === null ? null : pct(t.irrHurdle, 1),
      hurdleSub: t.irrHurdle === null ? 'open-ended' : t.hurdleMet === null ? 'not measured' : t.hurdleMet ? 'cleared' : 'not cleared',
      hurdleTone: t.irrHurdle === null || t.hurdleMet === null ? 'dim2' : t.hurdleMet ? 'pos' : 'neg',
      split: t.gpShare,
      investors: gross - promote,
      gp: promote,
    });
  });

  if (totals.gpClawback > EPS) {
    rows.push({
      key: 'clawback',
      label: 'Promote clawback',
      // The returned dollars land back in the pref and capital rows above, so
      // counting them again in the investor column here would double them.
      sub: 'returned to the investor class above',
      hurdle: null,
      hurdleSub: 'lookback at sale',
      hurdleTone: 'warnc',
      split: null,
      investors: null,
      gp: -totals.gpClawback,
    });
  }

  const toInvestors = rows.reduce((s, r) => s + (r.investors ?? 0), 0);
  const toGp = rows.reduce((s, r) => s + (r.gp ?? 0), 0);

  return (
    <>
      <table className="grid">
        <thead>
          <tr>
            <th>Tier</th>
            <th className="r">Hurdle</th>
            <th className="r">GP split</th>
            <th className="r">To investors</th>
            <th className="r">To GP promote</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="name">
                {r.label}
                <span className="sub">{r.sub}</span>
              </td>
              <td className="r num">
                {r.hurdle ?? <span className="dim2">—</span>}
                <span className={`sub ${r.hurdleTone}`}>{r.hurdleSub}</span>
              </td>
              {/* Whole percent turned a 22.5% promote into a displayed 23%,
                  a different split from the one being applied to the column
                  beside it. Only an exact whole number renders as one. */}
              <td className="r num dim">{r.split === null ? <span className="dim2">—</span> : splitPct(r.split)}</td>
              <td className="r num">{r.investors === null ? <span className="dim2">—</span> : dollars(r.investors)}</td>
              <td className={`r num ${negClass(r.gp)}`}>
                {r.gp === null ? <span className="dim2">—</span> : dollars(r.gp)}
              </td>
            </tr>
          ))}
          <tr className="total">
            <td>
              Total
              <span className="sub">both columns together are every distributed dollar</span>
            </td>
            <td />
            <td />
            <td className="r num">{dollars(toInvestors)}</td>
            <td className="r num">{dollars(toGp)}</td>
          </tr>
        </tbody>
      </table>
      <div className="foot">
        Investor dollars are shared pari passu, so the sponsor takes {pct(config.gpCoInvestShare, 1)} of the
        investor column on its co-invest before any promote.
        {config.tiers.length === 1 && ' A single open tier splits every residual dollar the same way, whatever the LP earns.'}
      </div>
    </>
  );
}

function SplitPanel({ result, model }) {
  const { totals, returns } = result;
  const total = totals.distributions;
  const promote = totals.gpPromoteNet;
  const coInvest = totals.gpDistributions - promote;

  const keys = [
    { key: 'lp', cls: 'k-lp', label: 'LP', amount: totals.lpDistributions },
    { key: 'co', cls: 'k-gpco', label: 'GP co-invest', amount: coInvest },
    { key: 'pr', cls: 'k-promote', label: 'GP promote, net', amount: promote },
  ];

  const rows = [
    { label: 'Contributed', lp: totals.lpContributions, gp: totals.gpContributions, all: totals.contributions, f: dollars },
    { label: 'Distributed', lp: totals.lpDistributions, gp: totals.gpDistributions, all: totals.distributions, f: dollars },
    { label: 'Profit', lp: returns.lpProfit, gp: returns.gpProfit, all: totals.distributions - totals.contributions, f: dollars },
    { label: 'IRR', lp: returns.lpIRR, gp: returns.gpIRR, all: model.returns.leveredIRR, f: (v) => pct(v) },
    { label: 'Equity multiple', lp: returns.lpEquityMultiple, gp: returns.gpEquityMultiple, all: model.returns.equityMultiple, f: mult },
  ];

  return (
    <Panel title="Split of distributions" right={<span className="dim" style={{ fontSize: '11px' }}>{dollars(total)}</span>}>
      {total > EPS ? (
        <div className="splitbar" style={{ marginBottom: '10px' }}>
          {keys.map((k) => (
            <span key={k.key} className={k.cls} style={{ width: `${Math.max(0, (k.amount / total) * 100)}%` }} />
          ))}
        </div>
      ) : (
        <div className="dim2" style={{ fontSize: '11px', marginBottom: '10px' }}>
          Nothing was ever distributed, so there is no split to draw.
        </div>
      )}

      {keys.map((k) => (
        <div key={k.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', fontSize: '12px' }}>
          <span className={`swatch ${k.cls}`} />
          <span className="dim">{k.label}</span>
          <span className="spacer" />
          <span className="num">{dollars(k.amount)}</span>
          <span className="num dim2" style={{ width: '48px', textAlign: 'right' }}>
            {total > EPS ? pct(k.amount / total, 1) : NA}
          </span>
        </div>
      ))}

      <table className="grid" style={{ marginTop: '12px' }}>
        <thead>
          <tr>
            <th />
            <th className="r">LP</th>
            <th className="r">GP</th>
            <th className="r">Deal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="dim">{r.label}</td>
              <td className={`r num ${negClass(r.lp)}`}>{r.f(r.lp)}</td>
              <td className={`r num ${negClass(r.gp)}`}>{r.f(r.gp)}</td>
              <td className={`r num dim ${negClass(r.all)}`}>{r.f(r.all)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="foot" style={{ paddingLeft: 0, paddingRight: 0, marginTop: '4px' }}>
        Promote ÷ profit is the sponsor figure that survives comparison between deals. GP IRR and GP
        multiple are measured on the co-invest alone, so a sponsor that funds little of the equity
        reports a large number describing the size of its cheque rather than the quality of the
        deal. An IRR cell reads {NA} for either of two reasons: no capital was ever at risk, or the
        flows admit no rate at all — which is what a total loss looks like. The multiple beside it
        tells the two apart. A single IRR on an LP or GP series is indicative rather than exact:
        promote and co-invest can change sign more than once, and such a series can admit several
        rates.
      </div>
    </Panel>
  );
}

function Callout({ tone, title, detail }) {
  return (
    <div className={`callout ${tone}`}>
      <AlertTriangle size={14} style={{ flex: 'none', marginTop: '2px' }} />
      <div>
        <div className="ct">{title}</div>
        <div className="cd">{detail}</div>
      </div>
    </div>
  );
}
