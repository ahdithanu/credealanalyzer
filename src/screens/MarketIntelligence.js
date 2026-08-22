import React, { useMemo, useState } from 'react';
import { Panel, Seg } from '../ui/components';
import { findMarket } from '../lib/markets';
import { scoreAll } from '../lib/marketScore';
import { rankNearbyMarkets } from '../lib/siteSelection';
import { propertyTypes } from '../lib/propertyTypes';
import { NA } from '../lib/format';

const RADII = [50, 100, 250, 1000];

export default function MarketIntelligence({ deal }) {
  const [propertyType, setPropertyType] = useState(deal?.propertyType ?? 'multifamily');
  const [radius, setRadius] = useState(250);
  const [selected, setSelected] = useState(null);

  const origin = deal ? findMarket(deal.location) : null;

  const ranked = useMemo(() => {
    if (origin) {
      const { origin: o, candidates } = rankNearbyMarkets(origin, { propertyType, radiusMiles: radius, limit: 40 });
      return { origin: o, rows: candidates };
    }
    return { origin: null, rows: scoreAll({ propertyType }).map((r) => ({ ...r, distance: null, scoreDelta: null, differentiators: [] })) };
  }, [origin, propertyType, radius]);

  const active = selected
    ? ranked.rows.find((r) => r.marketKey === selected) ?? ranked.origin
    : ranked.origin ?? ranked.rows[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span className="lbl">Market intelligence</span>
        <select className="inp" style={{ width: 'auto', height: '26px', fontSize: '11.5px' }} value={propertyType} onChange={(e) => setPropertyType(e.target.value)}>
          {Object.entries(propertyTypes).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
        </select>
        <Seg
          options={RADII.map((r) => ({ value: r, label: r >= 1000 ? 'All' : `${r} mi` }))}
          value={radius}
          onChange={setRadius}
        />
        {origin && <span className="chip acc">from {origin.city}, {origin.state}</span>}
        <span className="spacer" />
        <span className="chip warn">Weights: default prior — not fitted</span>
        <span className="prov">Seed data · not sourced</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', flex: 1, minHeight: 0 }}>
        <Panel title="Geography" flush style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <MarketMap
            rows={ranked.rows}
            origin={ranked.origin}
            active={active}
            onPick={(k) => setSelected(k)}
          />
        </Panel>

        <Panel title="Ranked markets" flush style={{ overflow: 'auto', minHeight: 0 }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Market</th>
                <th className="r">Score</th>
                <th className="r">vs. subj</th>
                <th className="r">Pop gr</th>
                <th className="r">Jobs</th>
                <th className="r">Pipeline</th>
                <th className="r">Tax</th>
                <th className="r">Dist</th>
              </tr>
            </thead>
            <tbody>
              {ranked.origin && (
                <MarketRow row={ranked.origin} subject onClick={() => setSelected(ranked.origin.marketKey)} active={active?.marketKey === ranked.origin.marketKey} />
              )}
              {ranked.rows.map((r) => (
                <MarketRow key={r.marketKey} row={r} onClick={() => setSelected(r.marketKey)} active={active?.marketKey === r.marketKey} />
              ))}
              {!ranked.rows.length && (
                <tr><td colSpan={8}><div className="empty">No markets within {radius} miles.</div></td></tr>
              )}
            </tbody>
          </table>
        </Panel>
      </div>

      {/* Explainability drawer. An IC asking "why 71?" gets a decomposition,
          not a tooltip — this is the whole reason the score is defensible. */}
      {active && (
        <Panel
          title={`Why ${active.market.city} scores ${active.score.toFixed(0)}`}
          right={
            <span className="dim" style={{ fontSize: '11px' }}>
              50 = median across every factor · coverage {(active.coverage * 100).toFixed(0)}% · {active.provenance.fitted ? 'firm-fitted weights' : 'default prior'}
            </span>
          }
        >
          <Contributions scored={active} />
        </Panel>
      )}
    </div>
  );
}

function MarketRow({ row, subject, onClick, active }) {
  const m = row.market;
  return (
    <tr className={active ? 'sel' : ''} style={{ cursor: 'pointer' }} onClick={onClick}>
      <td className="name">
        {m.city}, {m.state}
        {subject && <span className="sub acc">subject market</span>}
        {!subject && row.differentiators?.length > 0 && (
          <span className="sub">{row.differentiators.map((d) => d.label).join(' · ')}</span>
        )}
      </td>
      <td className="r num" style={{ fontWeight: 600 }}>{row.score.toFixed(0)}</td>
      <td className={`r num ${row.scoreDelta > 0 ? 'pos' : row.scoreDelta < 0 ? 'neg' : 'dim2'}`}>
        {row.scoreDelta === null || subject ? '—' : `${row.scoreDelta > 0 ? '+' : ''}${row.scoreDelta.toFixed(0)}`}
      </td>
      <td className="r num dim">{m.popGrowth5y.toFixed(1)}%</td>
      <td className="r num dim">{m.employmentGrowth.toFixed(1)}%</td>
      <td className="r num dim">{m.supplyPipeline.toFixed(1)}%</td>
      <td className="r num dim">{m.effectiveTaxRate.toFixed(2)}%</td>
      <td className="r num dim2">{Number.isFinite(row.distance) ? `${Math.round(row.distance)} mi` : '—'}</td>
    </tr>
  );
}

/** Signed contribution bars: what pushed the score above or below median. */
function Contributions({ scored }) {
  const max = Math.max(...scored.contributions.map((c) => Math.abs(c.contribution)), 1e-9);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '4px 22px' }}>
      {scored.contributions.map((c) => (
        <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', padding: '2px 0' }} title={c.rationale}>
          <span className="dim" style={{ width: '112px', flex: 'none' }}>{c.label}</span>
          <div style={{ flex: 1, position: 'relative', height: '12px', minWidth: '60px' }}>
            <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: '1px', background: 'var(--line)' }} />
            <div
              style={{
                position: 'absolute', top: '3px', height: '6px', borderRadius: '1px',
                background: c.contribution >= 0 ? 'var(--pos)' : 'var(--neg)',
                opacity: 0.7,
                ...(c.contribution >= 0
                  ? { left: '50%', width: `${(c.contribution / max) * 50}%` }
                  : { right: '50%', width: `${(-c.contribution / max) * 50}%` }),
              }}
            />
          </div>
          <span className="num dim2" style={{ width: '34px', textAlign: 'right', flex: 'none' }}>
            {c.missing ? NA : `${c.contribution > 0 ? '+' : ''}${c.contribution.toFixed(1)}`}
          </span>
          <span className="num dim2" style={{ width: '40px', textAlign: 'right', flex: 'none', fontSize: '10px' }}>
            {c.percentile === null ? '' : `p${Math.round(c.percentile * 100)}`}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Equirectangular projection over the market set. Adequate at state scale. */
function MarketMap({ rows, origin, active, onPick }) {
  const all = [...(origin ? [origin] : []), ...rows];
  if (!all.length) return <div className="empty">No markets to plot.</div>;

  const lats = all.map((r) => r.market.lat);
  const lngs = all.map((r) => r.market.lng);
  const pad = 1.2;
  const minLat = Math.min(...lats) - pad;
  const maxLat = Math.max(...lats) + pad;
  const minLng = Math.min(...lngs) - pad;
  const maxLng = Math.max(...lngs) + pad;

  const W = 100;
  const H = 70;
  const px = (lng) => ((lng - minLng) / (maxLng - minLng)) * W;
  const py = (lat) => H - ((lat - minLat) / (maxLat - minLat)) * H;

  return (
    <div style={{ padding: '10px', flex: 1, minHeight: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%', display: 'block' }}>
        {origin && rows.map((r) => (
          <line
            key={`l-${r.marketKey}`}
            x1={px(origin.market.lng)} y1={py(origin.market.lat)}
            x2={px(r.market.lng)} y2={py(r.market.lat)}
            stroke="var(--line-faint)" strokeWidth="0.15"
          />
        ))}
        {all.map((r, idx) => {
          const isActive = active?.marketKey === r.marketKey;
          const isOrigin = origin?.marketKey === r.marketKey;
          const labelled = isActive || isOrigin || idx <= 3;
          const radius = 0.8 + (r.score / 100) * 1.8;
          return (
            <g key={r.marketKey} onClick={() => onPick(r.marketKey)} style={{ cursor: 'pointer' }}>
              <circle
                cx={px(r.market.lng)} cy={py(r.market.lat)} r={radius}
                fill={isOrigin ? 'var(--accent-bright)' : 'var(--accent)'}
                fillOpacity={isActive ? 0.95 : 0.45}
                stroke={isActive ? 'var(--accent-bright)' : 'none'}
                strokeWidth="0.3"
              />
              {labelled && (
                <text
                  x={px(r.market.lng)} y={py(r.market.lat) - radius - 0.7}
                  textAnchor="middle"
                  style={{ fontSize: '1.8px', fill: isActive ? 'var(--text)' : 'var(--text-4)' }}
                >
                  {r.market.city}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: '10px', color: 'var(--text-4)', marginTop: '4px' }}>
        Marker size is the opportunity score; only the subject, the selection and the top
        candidates are labelled. Equirectangular projection — table distances are
        great-circle, not projected.
      </div>
    </div>
  );
}
