import React, { useMemo, useState } from 'react';
import { runModel, DEFAULT_DEBT_SIZING } from '../lib/finance';
import { validate, flagCounts, breakEvenBreach, DEFAULT_COVENANTS } from '../lib/validation';
import { overrides, firmDefault, FIRM_DEFAULTS } from '../lib/firmDefaults';
import { propertyTypes, constructionTypes } from '../lib/propertyTypes';
import { Panel, MetricStrip, FlagList, Seg } from '../ui/components';
import { irrQualification, irrMarkText, IRR_FOOTNOTE } from './irrQualification';
import { money, money0, thousands, pct, mult, bps, num, NA } from '../lib/format';

const GROUPS = [
  { key: 'site',      label: 'Site & program' },
  { key: 'budget',    label: 'Dev budget' },
  { key: 'revenue',   label: 'Revenue' },
  { key: 'opex',      label: 'OpEx' },
  { key: 'financing', label: 'Financing' },
  { key: 'exit',      label: 'Exit' },
];

const FIELDS = {
  site: [
    { f: 'location', label: 'Market', type: 'text' },
    { f: 'propertyType', label: 'Property type', type: 'select', options: propertyTypes },
    { f: 'constructionType', label: 'Construction', type: 'select', options: constructionTypes },
    { f: 'buildingSize', label: 'Building size', unit: 'sf' },
    { f: 'units', label: 'Units', unit: '' },
  ],
  budget: [
    { f: 'purchasePrice', label: 'Land / acquisition', unit: '$' },
    { f: 'constructionCost', label: 'Hard cost', unit: '$' },
    { f: 'ffe', label: 'FF&E and amenities', unit: '$' },
    { f: 'financingCosts', label: 'Financing costs', unit: '$' },
    { f: 'contingencyRate', label: 'Contingency', unit: 'rate' },
  ],
  revenue: [
    { f: 'grossRevenue', label: 'Gross revenue (annual)', unit: '$' },
    { f: 'vacancyRate', label: 'Stabilized vacancy', unit: '%' },
    { f: 'rentGrowth', label: 'Rent growth', unit: 'rate', assumption: true },
  ],
  opex: [
    { f: 'operatingExpenseRatio', label: 'OpEx ratio (excl. tax)', unit: '%' },
    { f: 'expenseRecoveryRate', label: 'Expense recovery (NNN)', unit: 'rate' },
    { f: 'expenseGrowth', label: 'Expense growth', unit: 'rate', assumption: true },
  ],
  financing: [
    { f: 'downPayment', label: 'Equity share', unit: '%' },
    { f: 'interestRate', label: 'All-in rate', unit: '%' },
    { f: 'loanTerm', label: 'Amortization', unit: 'yrs' },
    { f: 'interestOnlyMonths', label: 'Interest-only', unit: 'mo', assumption: true, placeholder: 'through stabilization' },
    { f: 'gpCoInvestShare', label: 'GP co-invest', unit: 'rate' },
  ],
  exit: [
    { f: 'exitCapRate', label: 'Exit cap', unit: '%' },
    { f: 'entryCapRate', label: 'Entry cap', unit: '%' },
    { f: 'holdPeriod', label: 'Hold period', unit: 'yrs' },
    { f: 'costOfSalePct', label: 'Cost of sale', unit: 'rate', assumption: true },
  ],
};

// The three lender tests, in the order sizeDebt() resolves ties in, so the row
// a reader sees marked as binding is the one the engine actually picked.
const SIZING_TESTS = [
  { key: 'ltc',       label: 'Loan to cost',  limit: (l) => pct(l.maxLTC, 1) },
  { key: 'dscr',      label: 'DSCR',          limit: (l) => mult(l.minDSCR) },
  { key: 'debtYield', label: 'Debt yield',    limit: (l) => pct(l.minDebtYield, 2) },
];

// The short form of IRR_FOOTNOTE, for the metric tile's one-line note. The full
// sentence is on the panel footnote below; the tile has no room for it.
const IRR_MARK_EXPLAINER = 'marked figures solve the IRR equation but are not unique';

export default function DealModel({ deal, onChange, posture, onPosture }) {
  const [group, setGroup] = useState('financing');

  const model = useMemo(() => runModel(deal), [deal]);
  const flags = useMemo(() => validate(model, deal), [model, deal]);
  const counts = flagCounts(flags);
  const ov = overrides(deal);
  const flaggedFields = new Set(flags.map((f) => f.field));

  const set = (field, value, isAssumption) => {
    if (isAssumption) {
      onChange({ ...deal, assumptions: { ...(deal.assumptions || {}), [field]: value } });
    } else {
      onChange({ ...deal, [field]: value });
    }
  };

  const { budget, financing, operating, returns } = model;
  const cov = DEFAULT_COVENANTS;
  // The request comes off the MODEL, which states it on every path including
  // the one where the deal asked and no schedule existed to size against.
  // Reading `deal.sizeDebtToConstraints` is the screen reaching back past the
  // model it was handed to re-derive a fact the model already carries.
  const sized = Boolean(financing.sizingRequested);

  // A covenant verdict is only meaningful once the metric exists. Coercing an
  // unmeasured figure to zero reads it as the worst possible answer and prints
  // 'breaches' under an 'n/a' value, which is a fabricated finding.
  const verdict = (value, limit, ok, fail) =>
    value === null || value === undefined || !Number.isFinite(value) ? 'not measured'
      : value >= limit ? ok : fail;

  // The equity share the sizer actually ran at. runSizedToConstraints computes
  // its own downPayment internally and never writes it back to the deal, so the
  // stored input is the DISCARDED one: on Katy Freeway the field read 35% while
  // the model was funded at 30.74%, a $3.7m overstatement of equity at risk
  // annotated "set by debt sizing". The annotation is only true of this value.
  const sizedEquityShare = sized && budget.baseProjectCost > 0
    ? (financing.equityCommitment / budget.baseProjectCost) * 100
    : null;

  const spread = operating.developmentSpreadBps;
  const dscr = operating.minStabilizedDSCR;
  const breakEven = operating.breakEvenOccupancy;

  // Whether each IRR on this tile is THE return or merely A root. finance.js
  // solves by bisection and hands back the first bracketed rate; when the flow
  // series turns over more than once several rates satisfy the equation, and
  // the tile used to print that rate in exactly the same type as a settled one.
  // Nothing is rendered when the flag is null — an incomplete model established
  // no series and therefore no doubt either.
  const leveredQ = irrQualification(returns.irrDiagnostics, 'levered');
  const unleveredQ = irrQualification(returns.irrDiagnostics, 'unlevered');
  const irrNote = `unlevered ${pct(returns.unleveredIRR)}${irrMarkText(unleveredQ)}`;

  const metrics = [
    {
      k: 'Levered IRR',
      v: `${pct(returns.leveredIRR)}${irrMarkText(leveredQ)}`,
      // The strip titles the whole tile with `${k}: ${v} — ${n}`, so the
      // explanation has to be text rather than a node or it stringifies to
      // [object Object] in the tooltip.
      n: leveredQ || unleveredQ
        ? `${irrNote} · ${IRR_MARK_EXPLAINER}`
        : irrNote,
    },
    { k: 'Equity multiple', v: mult(returns.equityMultiple), n: `${money(returns.totalDistributions)} distributed` },
    {
      k: 'Yield on cost', v: pct(operating.yieldOnCost, 2),
      // A model with no schedule reports no stabilization month, and the bare
      // interpolation printed the string "mo null" onto the tile. Month 0 is a
      // real month (the closing), so this cannot fall back to a number either.
      n: operating.stabilizationMonth === null || operating.stabilizationMonth === undefined
        ? `stabilized NOI ÷ TDC · stabilization ${NA}`
        : `stabilized NOI ÷ TDC · mo ${operating.stabilizationMonth}`,
    },
    {
      // Deliberately adjacent to yield on cost and never merged with it: one
      // prices income already in place against what is paid for it, the other
      // prices stabilised income against everything spent to get there. The
      // tile stays on screen when the metric does not apply so a reader learns
      // that ground-up has no going-in yield rather than hunting for the tile.
      k: 'Going-in cap', v: pct(operating.goingInCapRate, 2),
      n: goingInNote(operating),
    },
    {
      k: 'Dev spread', v: spread === null ? NA : bps(spread),
      n: `min ${cov.minDevSpreadBps} bps · ${verdict(spread, cov.minDevSpreadBps, 'clears', 'short')}`,
      tone: spread !== null && spread < cov.minDevSpreadBps ? 'neg' : '',
    },
    {
      k: 'DSCR stabilized', v: mult(dscr),
      n: `covenant ${mult(cov.minDSCR)} · ${verdict(dscr, cov.minDSCR, 'clears', 'breaches')}`,
      tone: dscr !== null && dscr < cov.minDSCR ? 'neg' : '',
    },
    {
      // A ratio on the model, not a percent — pct() does the conversion. It is
      // null for an asset with no rentable income, where there is no occupancy
      // to solve for, and 0% would claim the building pays for itself empty.
      //
      // Both of validation.js's rules are tested here, not just the ceiling.
      // Testing the ceiling alone printed "clears" with no negative tone on
      // deals where validate() raised an ERROR — a break-even 12 points above
      // the occupancy the deal itself underwrites still sits under an 80%
      // ceiling. In Grid posture the Validation panel is hidden and this tile
      // is the only break-even statement on the screen, so a tile that
      // disagrees with the flag list is the whole answer a reader gets.
      k: 'Break-even occupancy', v: pct(breakEven, 1),
      n: breakEvenNote(operating, cov),
      tone: breakEvenBreach(operating, cov).breached ? 'neg' : '',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', height: '100%' }}>
      {/* Assumption band. Horizontal across the top, per wireframe 1e. */}
      <div className="panel">
        <div className="panel-hd" style={{ gap: '4px' }}>
          {GROUPS.map((g) => (
            <button
              key={g.key}
              className={`btn ghost ${g.key === group ? 'on' : ''}`}
              style={{ height: '24px', fontSize: '11.5px' }}
              onClick={() => setGroup(g.key)}
            >
              {g.label}
            </button>
          ))}
          <span className="spacer" />
          {ov.length > 0 && (
            <span className="chip acc" title={ov.map((o) => o.field).join(', ')}>
              {ov.length} firm default{ov.length === 1 ? '' : 's'} overridden
            </span>
          )}
          <span className="chip">{FIRM_DEFAULTS.version}</span>
          <Seg
            options={[{ value: 'form', label: 'Form' }, { value: 'grid', label: 'Grid' }]}
            value={posture}
            onChange={onPosture}
          />
        </div>
        <div className="panel-bd" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: '14px' }}>
          {FIELDS[group].map((spec) => (
            <Field
              key={spec.f}
              spec={spec}
              deal={deal}
              flagged={flaggedFields.has(spec.f)}
              // Constrained sizing derives the equity share from the loan the
              // credit box supports, so the input no longer drives anything.
              // Leaving it live would let an analyst retype it and watch the
              // model refuse to move.
              superseded={sized && spec.f === 'downPayment'}
              supersededValue={spec.f === 'downPayment' ? sizedEquityShare : null}
              onSet={set}
            />
          ))}
        </div>
      </div>

      <MetricStrip items={metrics} />

      {(leveredQ || unleveredQ) && (
        <div className="dim2" style={{ fontSize: '10.5px', marginTop: '-6px' }}>{IRR_FOOTNOTE}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: posture === 'grid' ? '1fr' : '1.55fr 1fr', gap: '12px', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 }}>
          <Panel
            title="Sources & uses"
            right={<span className="dim" style={{ fontSize: '11px' }}>{money(budget.totalProjectCost)} total development cost</span>}
            flush
          >
            <SourcesUses model={model} deal={deal} />
          </Panel>
          <Panel title="Draw curve" right={<span className="dim" style={{ fontSize: '11px' }}>
            {/* Two different series, so each is named. The curve plots the
                construction draw; returns.peakEquity is the deepest cumulative
                equity outflow over the WHOLE hold, which on most deals falls
                after the last plotted month. Captioning the chart with it
                unlabelled put a value the curve never reaches, at a month index
                off the right of it, on the chart's own header. */}
            drawn <span className="num">{money(constructionEquity(model))}</span> by month {model.timeline.constructionMonths}
            {' · peak equity '}<span className="num">{money(returns.peakEquity)}</span>
            {peakMonth(model) === null ? '' : <> at month {peakMonth(model)}
              {peakMonth(model) > model.timeline.constructionMonths ? ' (past this chart)' : ''}</>}
          </span>}>
            <DrawCurve model={model} />
          </Panel>
          <Panel
            title="Debt sizing"
            right={
              <>
                {sized && financing.sizing && !financing.sizing.converged && (
                  <span className="chip warn" title={`${financing.sizing.passes} passes`}>not converged</span>
                )}
                <Seg
                  options={[{ value: 'equity', label: 'Equity share' }, { value: 'constrained', label: 'Credit box' }]}
                  value={sized ? 'constrained' : 'equity'}
                  onChange={(v) => onChange({ ...deal, sizeDebtToConstraints: v === 'constrained' })}
                />
              </>
            }
            flush
          >
            <DebtSizing model={model} deal={deal} sized={sized} />
          </Panel>
        </div>

        {posture !== 'grid' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 }}>
            <Panel
              title="Validation"
              right={<span className={`chip ${counts.error ? 'neg' : counts.warning ? 'warn' : 'pos'}`}>
                {counts.error + counts.warning + counts.info || 0} flag{counts.error + counts.warning + counts.info === 1 ? '' : 's'}
              </span>}
              flush
            >
              <FlagList flags={flags} onJump={(field) => {
                const g = GROUPS.find((x) => FIELDS[x.key].some((s) => s.f === field));
                if (g) setGroup(g.key);
              }} />
            </Panel>
            <Panel title="Capital stack" flush>
              <CapitalStack model={model} />
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The tile's note, from validation.js's own verdict rather than a second
 * implementation of it — so the tile and the flag list beside it cannot reach
 * different conclusions about the same metric.
 */
function breakEvenNote(operating, cov) {
  const v = breakEvenBreach(operating, cov);
  if (v.breakEven === null) return 'no potential rent to solve for';
  const ceiling = `ceiling ${pct(v.ceiling, 0)}`;
  if (v.overCeiling) return `${ceiling} · breaches`;
  // Named for the test it actually failed. "breaches" against a ceiling the
  // number is plainly under sends the reader hunting for the wrong limit.
  if (v.noCushion) return `${ceiling} · no cushion over ${pct(v.underwrittenOcc, 1)} underwritten`;
  if (v.cushion === null) return `${ceiling} · clears`;
  return `${ceiling} · ${bps(v.cushion * 10000, true)} cushion`;
}

/**
 * Cumulative equity drawn by the end of construction — what the curve plots.
 * Null, not zero, with no schedule to draw from: "nothing was drawn" and "there
 * is no schedule" are different claims, and money() renders null as n/a.
 */
function constructionEquity(model) {
  if (!model.months.length) return null;
  const C = Math.min(model.timeline.constructionMonths, model.months.length);
  let cum = 0;
  for (let i = 0; i < C; i++) cum += model.months[i].equityDraw;
  return cum;
}

function peakMonth(model) {
  if (!model.months.length) return null;
  let cum = 0;
  let min = 0;
  let at = 0;
  model.months.forEach((m, i) => {
    cum += m.equityFlow;
    if (cum < min) { min = cum; at = i; }
  });
  return at + 1;
}

/**
 * Why the going-in cap reads as it does.
 *
 * When the metric does not exist the note has to name the reason, because a
 * bare 'n/a' beside a populated yield on cost reads as a defect in the model
 * rather than as a property of the deal.
 */
const GOING_IN_UNAVAILABLE = {
  'ground-up': 'ground-up · no income in place',
  'no-in-place-income': 'no in-place income underwritten',
  'no-acquisition-basis': 'no acquisition basis to price',
  'no-revenue-base': 'no rent roll to price occupancy against',
};

function goingInNote(operating) {
  if (operating.goingInCapRate !== null) {
    return `${money(operating.goingInNOI)} in-place NOI ÷ ${money(operating.acquisitionBasis)} basis`;
  }
  // The reason comes off the model, which is the only thing that knows which of
  // the three tests actually failed; re-deriving it here is how a screen ends up
  // calling a tenant-improvement deal ground-up.
  return GOING_IN_UNAVAILABLE[operating.goingInCapUnavailable] ?? 'not measured on this deal';
}

/**
 * The lender's three tests, and which one actually decided the loan.
 *
 * The binding test is the point of the panel: an LTC-bound deal is solved with
 * more equity, a coverage-bound deal is not solved with equity at all, and the
 * loan amount alone does not tell them apart.
 */
function DebtSizing({ model, deal, sized }) {
  const { financing, operating, budget } = model;
  const limits = { ...DEFAULT_DEBT_SIZING, ...(deal.debtSizing || {}) };
  const sizing = financing.sizing;
  // Constrained mode with no sizing result means the model never reached a
  // schedule to size against; reporting the equity-share loan there would
  // attribute an unsized number to the credit box.
  const constraints = sizing ? sizing.constraints : null;

  // In equity-share mode the same three tests are still worth reading, but as
  // outcomes rather than limits: what the loan the input produced measures at.
  // Each carries whether it is OUTSIDE the limit beside it, because a loan
  // outside the credit box otherwise renders identically to one inside it and
  // the column then reads as three unrelated statistics.
  const achieved = {
    ltc: { text: pct(financing.ltc, 1), out: financing.ltc !== null && financing.ltc > limits.maxLTC },
    dscr: {
      text: mult(operating.minStabilizedDSCR),
      out: operating.minStabilizedDSCR !== null && operating.minStabilizedDSCR < limits.minDSCR,
    },
    debtYield: {
      text: pct(operating.debtYield, 2),
      out: operating.debtYield !== null && operating.debtYield < limits.minDebtYield,
    },
  };
  // An unmeasurable LTC leaves the equity residual unmeasurable too — 100%
  // equity is a different claim from "cost unknown".
  const equityShare = financing.ltc === null ? null : 1 - financing.ltc;
  // The equity share the model actually RAN at, on the input field's own
  // denominator (base cost, before the interest reserve). `1 - ltc` is a third
  // number — equity over TOTAL cost — and quoting the two under one name is how
  // this panel and the Financing band came to disagree by four points.
  const equityShareOfBase = budget.baseProjectCost > 0
    ? financing.equityCommitment / budget.baseProjectCost
    : null;

  return (
    <div>
      <table className="grid">
        <thead>
          <tr>
            <th>Lender test</th>
            <th className="r">Limit</th>
            <th className="r">{sized ? 'Supports' : 'Measures'}</th>
          </tr>
        </thead>
        <tbody>
          {SIZING_TESTS.map((t) => {
            const binds = sized && sizing && sizing.bindingConstraint === t.key;
            return (
              <tr key={t.key}>
                <td className={binds ? 'name acc' : 'name'}>
                  {t.label}
                  {binds && <span className="chip acc" style={{ marginLeft: '7px' }}>binds</span>}
                </td>
                <td className="r num dim">{t.limit(limits)}</td>
                <td className={`r num ${binds ? 'acc' : ''} ${!sized && achieved[t.key].out ? 'neg' : ''}`}>
                  {sized
                    ? (constraints ? money0(constraints[t.key]) : NA)
                    : <>{achieved[t.key].text}{achieved[t.key].out && <span className="dim2"> outside</span>}</>}
                </td>
              </tr>
            );
          })}
          <tr className="total">
            <td>Permanent balance</td>
            {/* In sized mode the rows above carry dollar limits, so the loan's
                own LTC is new information here; in equity mode the LTC row
                already reports it and the equity residual is what is missing. */}
            <td className="r num dim">
              {sized ? `${pct(financing.ltc, 1)} of total cost` : `${pct(equityShare, 1)} equity of total cost`}
            </td>
            {/* No `model.incomplete` guard: the engine reports an unmodelled
                permanent balance as null and money0 renders null as n/a, so a
                guard here would be the screen restating a claim the engine now
                makes for itself. */}
            <td className="r num">{money0(financing.permanentLoanBalance)}</td>
          </tr>
        </tbody>
      </table>
      <div className="dim2" style={{ fontSize: '10.5px', padding: '10px 10px 12px', lineHeight: 1.5 }}>
        {sized
          ? sizing && sizing.honoured
            ? <>Sized to the smallest of the three tests. Equity is the residual — the {' '}
                <span className="num">{pct(equityShareOfBase, 1)}</span> equity share is an output here, not an input.
                {!sizing.converged && ' The basis-to-loan feedback did not settle within the pass limit; treat the balance as approximate.'}</>
            : 'No test could be evaluated on this deal, so no loan can be sized to the credit box.'
          : <>Loan falls out of the equity share input. Switch to <span className="acc">Credit box</span> to size to the binding lender test instead.</>}
      </div>
    </div>
  );
}

function Field({ spec, deal, flagged, superseded, supersededValue = null, onSet }) {
  const isAssumption = Boolean(spec.assumption);
  const stored = isAssumption ? deal.assumptions?.[spec.f] : deal[spec.f];
  const def = firmDefault(spec.f, deal.propertyType);
  // Show the effective value. A field carrying only the firm default must
  // render that default, not an empty box that reads as "unset".
  const raw = stored ?? def;
  const isOverride = def !== undefined && stored !== undefined && Math.abs(stored - def) > 1e-9;

  if (spec.type === 'select') {
    return (
      <div className="field">
        <label>{spec.label}</label>
        <select className="inp" value={deal[spec.f]} onChange={(e) => onSet(spec.f, e.target.value)}>
          {Object.entries(spec.options).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
        </select>
      </div>
    );
  }
  if (spec.type === 'text') {
    return (
      <div className="field">
        <label>{spec.label}</label>
        <input className="inp" value={deal[spec.f] ?? ''} onChange={(e) => onSet(spec.f, e.target.value)} />
      </div>
    );
  }

  const stale = spec.unit === 'rate' && typeof raw === 'number' ? raw * 100 : raw;
  // A superseded field shows the value the engine used, not the input the
  // engine discarded — otherwise the box, its own annotation and the panel that
  // states the derived share are three different numbers for one quantity.
  const derived = superseded && typeof supersededValue === 'number' && Number.isFinite(supersededValue);
  const display = derived ? Number(supersededValue.toFixed(2)) : stale;
  return (
    <div className="field">
      <label>
        {spec.label}
        {spec.unit && spec.unit !== 'rate' && spec.unit !== '$' && <span className="dim2"> ({spec.unit})</span>}
        {spec.unit === 'rate' && <span className="dim2"> (%)</span>}
      </label>
      <input
        className={`inp ${flagged ? 'flag' : ''}`}
        type="number"
        disabled={superseded}
        // Dimmed explicitly rather than left to the browser's disabled styling,
        // which is tuned for light chrome and washes out on this palette.
        style={superseded ? { opacity: 0.5 } : undefined}
        value={display ?? ''}
        placeholder={spec.placeholder}
        onChange={(e) => {
          const v = e.target.value === '' ? undefined : Number(e.target.value);
          onSet(spec.f, spec.unit === 'rate' && v !== undefined ? v / 100 : v, isAssumption);
        }}
      />
      {superseded ? (
        <span className="note">
          {derived ? <>set by debt sizing · input {num(stale, 1)} unused</> : 'set by debt sizing'}
        </span>
      ) : isOverride ? (
        <span className="override">
          firm default {spec.unit === 'rate' ? pct(def, 2) : num(def, def % 1 ? 2 : 0)}
          {' · '}
          <button
            className="btn ghost"
            style={{ height: '14px', padding: 0, fontSize: '10px', border: 0, color: 'var(--accent-bright)' }}
            onClick={() => onSet(spec.f, def, isAssumption)}
          >reset</button>
        </span>
      ) : def !== undefined ? (
        <span className="note">firm default</span>
      ) : null}
    </div>
  );
}

function SourcesUses({ model, deal }) {
  const { budget } = model;
  const perUnit = deal.units > 0 ? deal.units : null;
  // Not `|| 1`: that renders a share of an unknown total as a confident 0.0%
  // beside an amount cell that reads n/a. pct() renders the resulting non-finite
  // ratio as n/a instead.
  const denom = budget.totalProjectCost > 0 ? budget.totalProjectCost : null;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Use</th>
          <th className="r">$000</th>
          <th className="r">{perUnit ? '$/unit' : '$/sf'}</th>
          <th className="r">% TDC</th>
        </tr>
      </thead>
      <tbody>
        {budget.lines.map((l) => (
          <tr key={l.key}>
            <td>{l.label}</td>
            <td className="r num">{thousands(l.amount)}</td>
            <td className="r num dim">{unitCost(l.amount, perUnit, deal.buildingSize)}</td>
            <td className="r num dim">{pct(l.amount / denom, 1)}</td>
          </tr>
        ))}
        <tr className="total">
          <td>Total development cost</td>
          <td className="r num">{thousands(budget.totalProjectCost)}</td>
          <td className="r num">{unitCost(budget.totalProjectCost, perUnit, deal.buildingSize)}</td>
          <td className="r num">100%</td>
        </tr>
      </tbody>
    </table>
  );
}

function unitCost(amount, units, sf) {
  const d = units || sf;
  if (!d) return NA;
  return Math.round(amount / d).toLocaleString('en-US');
}

function CapitalStack({ model }) {
  const { financing, budget } = model;
  // A `|| 1` denominator turns an unknown total into a confident 0% width and a
  // confident 0.0% label beside an 'n/a' amount. With no total there is no
  // stack to draw.
  const total = budget.totalProjectCost > 0 ? budget.totalProjectCost : null;
  const parts = [
    { label: 'Senior debt', amount: financing.permanentLoanBalance, color: 'var(--accent)' },
    { label: 'LP equity', amount: financing.lpEquity, color: 'var(--accent-dim)' },
    { label: 'GP co-invest', amount: financing.gpCoInvest, color: 'var(--text-4)' },
  ];
  return (
    <div style={{ padding: '14px' }}>
      <div style={{ display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', marginBottom: '12px' }}>
        {parts.map((p) => (
          <div key={p.label} style={{ width: total && p.amount !== null ? `${(p.amount / total) * 100}%` : '0%', background: p.color }} />
        ))}
      </div>
      {parts.map((p) => (
        <div key={p.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '12px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: p.color, flex: 'none' }} />
          <span className="dim">{p.label}</span>
          <span className="spacer" />
          <span className="num">{money0(p.amount)}</span>
          <span className="num dim2" style={{ width: '44px', textAlign: 'right' }}>{pct(p.amount / total, 1)}</span>
        </div>
      ))}
    </div>
  );
}

/** Cumulative equity and debt drawn across the construction period. */
function DrawCurve({ model }) {
  // Bounded by the months that EXIST, not by the timeline's construction count.
  // A degenerate model (hold period cleared to 0) reports constructionMonths 18
  // with an empty months array, so the loop below indexed undefined and threw —
  // an uncaught render error that white-screened the entire application, rail
  // and all, from one keystroke in the Exit band.
  const C = Math.min(model.timeline.constructionMonths, model.months.length);
  if (C < 2) {
    return <div className="empty">
      {model.timeline.constructionMonths ? 'No draw schedule to plot.' : 'No construction period.'}
    </div>;
  }
  const w = 100;
  const h = 92;
  let cumEq = 0;
  const eq = [];
  const debt = [];
  for (let i = 0; i < C; i++) {
    cumEq += model.months[i].equityDraw;
    eq.push(cumEq);
    debt.push(model.months[i].loanBalance);
  }
  const max = Math.max(...eq, ...debt, 1);
  const path = (arr) => arr
    .map((v, i) => `${i ? 'L' : 'M'}${((i / (C - 1)) * w).toFixed(2)},${(h - (v / max) * h).toFixed(2)}`)
    .join(' ');

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: '92px', display: 'block' }}>
        <path d={`${path(eq)} L${w},${h} L0,${h} Z`} fill="var(--accent-wash)" />
        <path d={path(eq)} fill="none" stroke="var(--accent-bright)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
        <path d={path(debt)} fill="none" stroke="var(--text-4)" strokeWidth="0.8" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: 'flex', gap: '16px', marginTop: '8px', fontSize: '10.5px', color: 'var(--text-4)' }}>
        <span><span className="acc">—</span> cumulative equity</span>
        <span>--- cumulative debt draw</span>
        <span className="spacer" />
        <span>Construction {C}mo · lease-up {model.timeline.leaseUpMonths}mo · hold {(model.timeline.operatingMonths / 12).toFixed(0)}yr</span>
      </div>
    </div>
  );
}
