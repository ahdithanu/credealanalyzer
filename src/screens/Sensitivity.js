import React, { useMemo, useState } from 'react';
import { Panel, fmtMetric } from '../ui/components';
import { runModel } from '../lib/finance';
import { runScenarios, sensitivityGrid, tornado, breakeven, VARIABLES, METRICS } from '../lib/sensitivity';
import { DEFAULT_COVENANTS } from '../lib/validation';
import { money, pct, mult, bps, pctRaw, NA } from '../lib/format';
import { irrQualification, IrrMark, IRR_FOOTNOTE } from './irrQualification';

// The firm's stated covenants, read from the one module that states them. The
// DSCR target and the spread floor below were literals here — 1.25 and 100 —
// duplicating DEFAULT_COVENANTS.minDSCR and .minDevSpreadBps, so a firm that
// moved either would have kept this screen solving for the old one while the
// Deal Model flagged against the new one.
const COV = DEFAULT_COVENANTS;

// NOT a firm default: there is no entry for a target IRR in FIRM_DEFAULTS, and
// this is the screen's own reference line for its scenario columns rather than
// a governed assumption. Left as a literal deliberately, and flagged as such so
// nobody reads it as house policy.
const TARGET_IRR = 0.18;

// Which displayed metrics are IRRs, and therefore carry a uniqueness question.
const IRR_SERIES = { leveredIRR: 'levered', unleveredIRR: 'unlevered' };

export default function Sensitivity({ deal }) {
  const [metric, setMetric] = useState('leveredIRR');
  const [xVar, setXVar] = useState('exitCapRate');
  const [yVar, setYVar] = useState('interestRate');

  const scenarios = useMemo(() => runScenarios(deal), [deal]);
  const grid = useMemo(() => sensitivityGrid(deal, { xVar, yVar, metric }), [deal, xVar, yVar, metric]);
  const tor = useMemo(() => tornado(deal, { metric }), [deal, metric]);

  const breakevens = useMemo(() => ([
    { label: `Exit cap for ${pct(TARGET_IRR, 0)} IRR`, value: breakeven(deal, { variable: 'exitCapRate', metric: 'leveredIRR', target: TARGET_IRR }), fmt: (v) => pctRaw(v, 2) },
    { label: `Revenue for ${mult(COV.minDSCR)} stabilized DSCR`, value: breakeven(deal, { variable: 'grossRevenue', metric: 'minStabilizedDSCR', target: COV.minDSCR }), fmt: money },
    { label: `Hard cost for ${COV.minDevSpreadBps} bps spread`, value: breakeven(deal, { variable: 'constructionCost', metric: 'developmentSpreadBps', target: COV.minDevSpreadBps }), fmt: money },
    { label: `Rate for ${mult(COV.minDSCR)} stabilized DSCR`, value: breakeven(deal, { variable: 'interestRate', metric: 'minStabilizedDSCR', target: COV.minDSCR }), fmt: (v) => pctRaw(v, 2) },
  ]), [deal]);

  const fmt = (v) => fmtMetric(v, METRICS[metric].format);

  // The uniqueness question for the exhibit rail. The grid and the tornado run
  // dozens of models but hand back only rates, so the diagnostic that exists per
  // model is not reachable per cell without re-running every one of them. What
  // IS reachable is the base case, and stating what is known about it — while
  // saying plainly that the cells are not individually tested — is the honest
  // reading. Claiming the cells inherit the base case's verdict would not be.
  const baseModel = useMemo(() => runModel(deal), [deal]);
  const irrSeries = IRR_SERIES[metric] ?? null;
  const gridQ = irrSeries ? irrQualification(baseModel.returns.irrDiagnostics, irrSeries) : null;
  const scenarioQualified = scenarios.some((sc) =>
    irrQualification(sc.model.returns.irrDiagnostics, 'levered') ||
    irrQualification(sc.model.returns.irrDiagnostics, 'unlevered'));

  const all = grid.rows.flat().filter((v) => v !== null);
  const lo = Math.min(...all);
  const hi = Math.max(...all);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: '12px', height: '100%', minHeight: 0 }}>
      {/* Scenario columns carry the screen, per wireframe 1l. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 }}>
        <Panel title="Scenarios" right={<span className="dim" style={{ fontSize: '11px' }}>target {pct(TARGET_IRR, 0)} levered IRR</span>} flush>
          <table className="grid">
            <thead>
              <tr>
                <th>Metric</th>
                {scenarios.map((s) => (
                  <th key={s.key} className="r" style={{ color: s.key === 'base' ? 'var(--accent-bright)' : undefined }}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <Row label="Levered IRR" s={scenarios} get={(m) => m.returns.leveredIRR} f={(v) => pct(v)} target={TARGET_IRR}
                   qualify={(m) => irrQualification(m.returns.irrDiagnostics, 'levered')} />
              <Row label="Unlevered IRR" s={scenarios} get={(m) => m.returns.unleveredIRR} f={(v) => pct(v)}
                   qualify={(m) => irrQualification(m.returns.irrDiagnostics, 'unlevered')} />
              <Row label="Equity multiple" s={scenarios} get={(m) => m.returns.equityMultiple} f={mult} />
              <Row label="Yield on cost" s={scenarios} get={(m) => m.operating.yieldOnCost} f={(v) => pct(v, 2)} />
              <Row label="Dev spread" s={scenarios} get={(m) => m.operating.developmentSpreadBps} f={(v) => bps(v)} target={COV.minDevSpreadBps} />
              <Row label="DSCR stabilized" s={scenarios} get={(m) => m.operating.minStabilizedDSCR} f={mult} target={COV.minDSCR} />
              <Row label="DSCR incl. lease-up" s={scenarios} get={(m) => m.operating.minDSCR} f={mult} />
              <Row label="Peak equity" s={scenarios} get={(m) => m.returns.peakEquity} f={money} />
              <Row label="Profit" s={scenarios} get={(m) => m.returns.profit} f={money} />
            </tbody>
          </table>
          {scenarioQualified && (
            <div className="dim2" style={{ fontSize: '10.5px', padding: '8px 10px 10px', lineHeight: 1.45 }}>
              {IRR_FOOTNOTE}
            </div>
          )}
        </Panel>

        <Panel title="Breakeven" flush>
          <table className="grid">
            <tbody>
              {breakevens.map((b) => (
                <tr key={b.label}>
                  <td className="dim">{b.label}</td>
                  <td className="r num" style={{ fontWeight: 500 }}>
                    {b.value === null ? <span className="dim2" title="No solution in the search range">{NA}</span> : b.fmt(b.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      {/* Exhibit rail. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, overflow: 'auto' }}>
        <Panel
          title="Sensitivity"
          right={
            <div style={{ display: 'flex', gap: '6px' }}>
              <select className="inp" style={{ height: '24px', width: 'auto', fontSize: '11px' }} value={metric} onChange={(e) => setMetric(e.target.value)}>
                {Object.entries(METRICS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
          }
        >
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
            <select className="inp" style={{ height: '24px', fontSize: '11px' }} value={yVar} onChange={(e) => setYVar(e.target.value)}>
              {Object.entries(VARIABLES).map(([k, v]) => <option key={k} value={k}>rows: {v.label}</option>)}
            </select>
            <select className="inp" style={{ height: '24px', fontSize: '11px' }} value={xVar} onChange={(e) => setXVar(e.target.value)}>
              {Object.entries(VARIABLES).map(([k, v]) => <option key={k} value={k}>cols: {v.label}</option>)}
            </select>
          </div>
          <table className="grid" style={{ fontSize: '11px' }}>
            <thead>
              <tr>
                <th />
                {grid.xValues.map((x) => <th key={x} className="r">{axis(x, xVar)}</th>)}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, ri) => (
                <tr key={ri}>
                  <th style={{ position: 'static', textAlign: 'right', background: 'none' }}>{axis(grid.yValues[ri], yVar)}</th>
                  {row.map((v, ci) => (
                    <td key={ci} className="r num" style={{ background: shade(v, lo, hi), fontWeight: ri === 2 && ci === 2 ? 600 : 400 }}>
                      {fmt(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {gridQ && (
            <div className="dim2" style={{ fontSize: '10.5px', marginTop: '8px', lineHeight: 1.45 }}>
              Base case: {gridQ.text} Cells here are solved the same way and are not
              individually tested for uniqueness.
            </div>
          )}
        </Panel>

        <Panel title="Tornado" right={<span className="dim" style={{ fontSize: '11px' }}>
          impact on {METRICS[metric].label.toLowerCase()}
          {METRICS[metric].polarity < 0 && <span className="dim2"> · higher is worse</span>}
        </span>}>
          <Tornado tor={tor} fmt={fmt} polarity={METRICS[metric].polarity ?? 1} />
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, s, get, f, target, qualify }) {
  return (
    <tr>
      <td className="dim">{label}</td>
      {s.map((sc) => {
        const v = get(sc.model);
        const short = target !== undefined && v !== null && v < target;
        // Each scenario is its own model with its own flow series, so the
        // uniqueness question is answered per cell rather than once per row: a
        // downside case can turn over twice where the base case does not.
        const q = qualify ? qualify(sc.model) : null;
        return (
          <td key={sc.key} className={`r num ${short ? 'neg' : ''}`} style={{ fontWeight: sc.key === 'base' ? 600 : 400 }}>
            {v === null ? NA : f(v)}
            <IrrMark qualification={q} />
          </td>
        );
      })}
    </tr>
  );
}

const axis = (v, variable) =>
  VARIABLES[variable].unit === '$' ? money(v, 1) : v.toFixed(VARIABLES[variable].unit === '%' ? 2 : 1);

/** Single-hue sequential fill. No red-yellow-green heatmap. */
function shade(v, lo, hi) {
  if (v === null || hi === lo) return undefined;
  const t = (v - lo) / (hi - lo);
  return `rgba(145, 132, 217, ${(0.05 + t * 0.30).toFixed(3)})`;
}

function Tornado({ tor, fmt, polarity = 1 }) {
  const max = Math.max(...tor.bars.map((b) => b.swing), 1e-9);
  // Green is the better outcome, not the larger one. Every metric here was
  // higher-is-better until break-even occupancy, for which a rise erodes the
  // covenant cushion — so a fixed "above base is green" painted the revenue cut
  // that nearly halved that cushion as the favourable side of the bar.
  // Left is the below-base side, right the above-base side; which of those is
  // the good news depends on the metric.
  const belowBase = polarity < 0 ? 'var(--pos)' : 'var(--neg)';
  const aboveBase = polarity < 0 ? 'var(--neg)' : 'var(--pos)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
      {tor.bars.map((b) => {
        const lowSide = Math.min(b.low ?? 0, b.high ?? 0);
        const highSide = Math.max(b.low ?? 0, b.high ?? 0);
        const leftPct = ((tor.base - lowSide) / max) * 50;
        const rightPct = ((highSide - tor.base) / max) * 50;
        return (
          <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
            <span className="dim" style={{ width: '108px', flex: 'none' }}>{b.label}</span>
            <div style={{ flex: 1, position: 'relative', height: '14px' }}>
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: '1px', background: 'var(--line-strong)' }} />
              <div style={{ position: 'absolute', right: '50%', width: `${Math.max(0, leftPct)}%`, top: '3px', height: '8px', background: belowBase, opacity: 0.65 }} />
              <div style={{ position: 'absolute', left: '50%', width: `${Math.max(0, rightPct)}%`, top: '3px', height: '8px', background: aboveBase, opacity: 0.65 }} />
            </div>
            <span className="num dim2" style={{ width: '96px', textAlign: 'right', flex: 'none' }}>
              {fmt(b.low)} → {fmt(b.high)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
