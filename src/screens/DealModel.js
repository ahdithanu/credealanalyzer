import React, { useMemo, useState } from 'react';
import { runModel } from '../lib/finance';
import { validate, flagCounts } from '../lib/validation';
import { overrides, firmDefault, FIRM_DEFAULTS } from '../lib/firmDefaults';
import { propertyTypes, constructionTypes } from '../lib/propertyTypes';
import { Panel, MetricStrip, FlagList, Seg } from '../ui/components';
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

  const { budget, financing, operating, returns, timeline } = model;

  const metrics = [
    { k: 'Levered IRR', v: pct(returns.leveredIRR), n: `unlevered ${pct(returns.unleveredIRR)}` },
    { k: 'Equity multiple', v: mult(returns.equityMultiple), n: `${money(returns.totalDistributions)} distributed` },
    { k: 'Peak equity', v: money(returns.peakEquity), n: `month ${peakMonth(model)}` },
    { k: 'Yield on cost', v: pct(operating.yieldOnCost, 2), n: `stabilized mo ${operating.stabilizationMonth}` },
    {
      k: 'Dev spread', v: operating.developmentSpreadBps === null ? NA : bps(operating.developmentSpreadBps),
      n: `min 100 · ${operating.developmentSpreadBps >= 100 ? 'clears' : 'short'}`,
      tone: operating.developmentSpreadBps < 100 ? 'neg' : '',
    },
    {
      k: 'DSCR stabilized', v: mult(operating.minStabilizedDSCR),
      n: `covenant 1.25 · ${(operating.minStabilizedDSCR ?? 0) >= 1.25 ? 'clears' : 'breaches'}`,
      tone: (operating.minStabilizedDSCR ?? 0) < 1.25 ? 'neg' : '',
    },
    { k: 'Debt yield', v: pct(operating.debtYield, 2), n: `LTC ${pct(financing.ltc, 1)}` },
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
              onSet={set}
            />
          ))}
        </div>
      </div>

      <MetricStrip items={metrics} />

      <div style={{ display: 'grid', gridTemplateColumns: posture === 'grid' ? '1fr' : '1.55fr 1fr', gap: '12px', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 }}>
          <Panel
            title="Sources & uses"
            right={<span className="dim" style={{ fontSize: '11px' }}>{money(budget.totalProjectCost)} total development cost</span>}
            flush
          >
            <SourcesUses model={model} deal={deal} />
          </Panel>
          <Panel title="Draw curve" right={<span className="dim" style={{ fontSize: '11px' }}>equity first · months 1–{timeline.constructionMonths}</span>}>
            <DrawCurve model={model} />
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

function peakMonth(model) {
  let cum = 0;
  let min = 0;
  let at = 0;
  model.months.forEach((m, i) => {
    cum += m.equityFlow;
    if (cum < min) { min = cum; at = i; }
  });
  return at + 1;
}

function Field({ spec, deal, flagged, onSet }) {
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

  const display = spec.unit === 'rate' && typeof raw === 'number' ? raw * 100 : raw;
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
        value={display ?? ''}
        placeholder={spec.placeholder}
        onChange={(e) => {
          const v = e.target.value === '' ? undefined : Number(e.target.value);
          onSet(spec.f, spec.unit === 'rate' && v !== undefined ? v / 100 : v, isAssumption);
        }}
      />
      {isOverride ? (
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
  const denom = budget.totalProjectCost || 1;
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
  const total = budget.totalProjectCost || 1;
  const parts = [
    { label: 'Senior debt', amount: financing.permanentLoanBalance, color: 'var(--accent)' },
    { label: 'LP equity', amount: financing.lpEquity, color: 'var(--accent-dim)' },
    { label: 'GP co-invest', amount: financing.gpCoInvest, color: 'var(--text-4)' },
  ];
  return (
    <div style={{ padding: '14px' }}>
      <div style={{ display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', marginBottom: '12px' }}>
        {parts.map((p) => (
          <div key={p.label} style={{ width: `${(p.amount / total) * 100}%`, background: p.color }} />
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
  const C = model.timeline.constructionMonths;
  if (!C) return <div className="empty">No construction period.</div>;
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
