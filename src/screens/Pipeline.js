import React, { useMemo, useState } from 'react';
import { Sparkline } from '../ui/components';
import { money, pct, mult, num, NA } from '../lib/format';
import { DEAL_STAGES } from '../lib/sampleDeals';
import { propertyTypes } from '../lib/propertyTypes';
import { DEFAULT_COVENANTS } from '../lib/validation';
import { irrQualification, IrrMark, IRR_FOOTNOTE } from './irrQualification';

// The covenant itself, read from the one place that states it. It was written
// here as a literal 1.25 beside the sizer's own DEFAULT_DEBT_SIZING.minDSCR, so
// a firm that moved its coverage floor would have kept a pipeline column
// colouring rows against the old one.
const MIN_DSCR = DEFAULT_COVENANTS.minDSCR;
const DSCR_WATCHLIST = MIN_DSCR + 0.05;

const SAVED_VIEWS = [
  { key: 'all',     label: 'All active',      test: (d) => d.stage !== 'Closed' },
  { key: 'ic',      label: 'IC Thursday',     test: (d) => d.stage === 'IC Thursday' },
  { key: 'groundup',label: 'Texas ground-up', test: (d) => d.constructionType === 'groundUp' && /TX$/.test(d.location) },
  // A WATCHLIST threshold, deliberately above the covenant: this view exists to
  // surface deals approaching the limit, not deals already through it. Written
  // as covenant-plus-cushion so it cannot drift away from the covenant it
  // watches. It is NOT itself a firm default, and there is no entry for it in
  // FIRM_DEFAULTS.
  { key: 'dscr',    label: 'DSCR at risk',    test: (d, m) => (m.operating.minStabilizedDSCR ?? 9) < DSCR_WATCHLIST },
  { key: 'every',   label: 'Everything',      test: () => true },
];

const COLUMNS = [
  { key: 'name',   label: 'Deal',    align: 'l' },
  { key: 'type',   label: 'Type',    align: 'l' },
  { key: 'market', label: 'Market',  align: 'l' },
  { key: 'stage',  label: 'Stage',   align: 'l' },
  { key: 'tdc',    label: 'TDC',     align: 'r' },
  { key: 'equity', label: 'Equity',  align: 'r' },
  { key: 'irr',    label: 'IRR',     align: 'r' },
  { key: 'em',     label: 'EM',      align: 'r' },
  { key: 'yoc',    label: 'YoC',     align: 'r' },
  { key: 'spread', label: 'Sprd',    align: 'r' },
  { key: 'dscr',   label: 'DSCR',    align: 'r' },
  { key: 'shape',  label: 'Shape',   align: 'l' },
];

const stageTone = (s) =>
  s === 'Closed' ? 'pos' : s === 'IC Thursday' ? 'acc' : s === 'Under LOI' ? '' : '';

export default function Pipeline({ deals, onOpen, onExport }) {
  const [view, setView] = useState('all');
  const [sort, setSort] = useState({ key: 'irr', dir: -1 });
  const [query, setQuery] = useState('');

  const rows = useMemo(() => deals.map((deal) => {
    const m = deal.metrics.model;
    return {
      deal,
      model: m,
      name: deal.name,
      type: propertyTypes[deal.propertyType]?.name ?? deal.propertyType,
      market: deal.location,
      stage: deal.stage ?? 'Screening',
      tdc: m.budget.totalProjectCost,
      equity: m.returns.peakEquity,
      irr: m.returns.leveredIRR,
      em: m.returns.equityMultiple,
      yoc: m.operating.yieldOnCost,
      spread: m.operating.developmentSpreadBps,
      dscr: m.operating.minStabilizedDSCR,
      // One rate that solves the equation, or the rate. finance.js records the
      // difference; nothing on this screen read it, so an indicative IRR sorted
      // and coloured exactly like a settled one.
      irrQ: irrQualification(m.returns.irrDiagnostics, 'levered'),
      shape: m.annual.map((y) => y.cashFlow),
    };
  }), [deals]);

  const activeView = SAVED_VIEWS.find((v) => v.key === view) ?? SAVED_VIEWS[0];
  const filtered = rows
    .filter((r) => activeView.test(r.deal, r.model))
    .filter((r) => !query || `${r.name} ${r.market} ${r.owner ?? ''}`.toLowerCase().includes(query.toLowerCase()));

  const sorted = [...filtered].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    if (typeof x === 'string') return x.localeCompare(y) * sort.dir;
    const ax = x ?? -Infinity;
    const by = y ?? -Infinity;
    return (ax - by) * sort.dir;
  });

  // Portfolio roll-up over what is on screen, so the header always describes
  // the rows beneath it rather than a hidden superset.
  const totalEquity = sorted.reduce((s, r) => s + (r.equity || 0), 0);
  const weightedIRR = totalEquity > 0
    ? sorted.reduce((s, r) => s + (r.irr ?? 0) * (r.equity || 0), 0) / totalEquity
    : null;
  const byStage = DEAL_STAGES.map((s) => ({ s, n: sorted.filter((r) => r.stage === s).length }));

  const toggleSort = (key) =>
    setSort((cur) => (cur.key === key ? { key, dir: -cur.dir } : { key, dir: -1 }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%' }}>
      {/* Portfolio line — small type, no oversized KPI tiles. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '28px', flexWrap: 'wrap' }}>
        <Stat k="Equity deployed" v={money(totalEquity)} />
        <Stat k="Weighted IRR" v={pct(weightedIRR)} />
        <Stat k="Deals" v={String(sorted.length)} />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
          <span className="lbl">By stage</span>
          {byStage.map(({ s, n }) => (
            <span key={s} style={{ fontSize: '11.5px', color: 'var(--text-3)' }}>
              {s} <span className="num" style={{ color: 'var(--text)' }}>{n}</span>
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
        {SAVED_VIEWS.map((v) => (
          <button
            key={v.key}
            className={`btn ghost ${v.key === view ? 'on' : ''}`}
            style={{ height: '25px', fontSize: '11.5px' }}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
        <span className="spacer" />
        <input
          className="inp"
          style={{ width: '190px', height: '25px' }}
          placeholder="Filter deals…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="panel" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table className="grid">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={c.align === 'r' ? 'r' : ''}
                  style={{ cursor: 'pointer' }}
                  onClick={() => toggleSort(c.key)}
                >
                  {c.label}
                  {sort.key === c.key && <span className="acc"> {sort.dir < 0 ? '↓' : '↑'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.deal.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(r.deal)}>
                <td className="name">
                  {r.name}
                  <span className="sub">{r.deal.program} · {r.deal.owner}</span>
                </td>
                <td className="dim">{r.type}</td>
                <td className="dim">{r.market}</td>
                <td><span className={`chip ${stageTone(r.stage)}`}>{r.stage}</span></td>
                <td className="r num">{money(r.tdc)}</td>
                <td className="r num">{money(r.equity)}</td>
                <td className="r num" style={{ fontWeight: 500 }}>
                  {pct(r.irr)}<IrrMark qualification={r.irrQ} />
                </td>
                <td className="r num">{mult(r.em)}</td>
                <td className="r num">{pct(r.yoc, 2)}</td>
                <td className={`r num ${r.spread < 0 ? 'neg' : ''}`}>
                  {r.spread === null ? NA : num(r.spread)}
                </td>
                <td className={`r num ${r.dscr !== null && r.dscr < MIN_DSCR ? 'neg' : ''}`}>
                  {mult(r.dscr)}
                </td>
                <td><Sparkline values={r.shape} /></td>
              </tr>
            ))}
            {!sorted.length && (
              <tr><td colSpan={COLUMNS.length}><div className="empty">No deals match this view.</div></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {sorted.some((r) => r.irrQ) && (
        <div className="dim2" style={{ fontSize: '10.5px' }}>{IRR_FOOTNOTE}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '11px', color: 'var(--text-4)' }}>
        <span>{sorted.length} of {deals.length} deals</span>
        <span className="prov">Market weights: default prior — not yet fitted to realised outcomes</span>
        <span className="spacer" />
        <button className="btn ghost" style={{ height: '25px', fontSize: '11.5px' }} onClick={onExport}>
          Export ledger
        </button>
      </div>
    </div>
  );
}

function Stat({ k, v }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
      <span className="lbl">{k}</span>
      <span className="num" style={{ fontSize: '15px', fontWeight: 500 }}>{v}</span>
    </div>
  );
}
