import React from 'react';
import { pct, mult, bps, money, signClass, NA } from '../lib/format';

export function Panel({ title, right, children, flush, style }) {
  return (
    <div className="panel" style={style}>
      {(title || right) && (
        <div className="panel-hd">
          <span className="lbl">{title}</span>
          <span className="spacer" />
          {right}
        </div>
      )}
      <div className={flush ? '' : 'panel-bd'}>{children}</div>
    </div>
  );
}

export function Seg({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A metric with its value and a qualifying note. The note carries the context
 * that makes the number defensible — the covenant it clears, the month peak
 * equity occurs, the year stabilization lands.
 */
export function MetricStrip({ items }) {
  return (
    <div className="strip">
      {items.map((m) => (
        // Titled with the whole tile, so a note the strip has to truncate on a
        // narrow window is still readable rather than merely cut off.
        <div className="m" key={m.k} title={`${m.k}: ${m.v}${m.n ? ` — ${m.n}` : ''}`}>
          <div className="k">{m.k}</div>
          <div className={`v num ${m.tone || ''}`}>{m.v}</div>
          {m.n && <div className="n">{m.n}</div>}
        </div>
      ))}
    </div>
  );
}

/** Inline cash-flow shape. Zero line drawn so negative periods read as negative. */
export function Sparkline({ values, width = 76, height = 20, stroke = 'var(--accent)' }) {
  const clean = (values || []).filter((v) => Number.isFinite(v));
  if (clean.length < 2) return <span className="dim2">—</span>;
  const min = Math.min(...clean, 0);
  const max = Math.max(...clean, 0);
  const span = max - min || 1;
  const x = (i) => (i / (clean.length - 1)) * width;
  const y = (v) => height - ((v - min) / span) * height;
  const d = clean.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {min < 0 && (
        <line x1="0" x2={width} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeWidth="1" />
      )}
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.25" />
    </svg>
  );
}

export function FlagList({ flags, onJump }) {
  if (!flags.length) {
    return <div className="empty" style={{ padding: '20px' }}>All covenants clear.</div>;
  }
  return (
    <div>
      {flags.map((f) => (
        <div
          className="flag-item"
          key={f.id}
          style={onJump ? { cursor: 'pointer' } : undefined}
          onClick={onJump ? () => onJump(f.field) : undefined}
        >
          <span className={`flag-dot ${f.severity}`} />
          <div>
            <div className="flag-t">{f.title}</div>
            <div className="flag-d">{f.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function FlagChip({ counts }) {
  const total = counts.error + counts.warning + counts.info;
  if (!total) return <span className="chip pos">0 flags</span>;
  const tone = counts.error ? 'neg' : counts.warning ? 'warn' : '';
  return <span className={`chip ${tone}`}>{total} flag{total === 1 ? '' : 's'}</span>;
}

/** Delta against a reference, rendered in the unit the metric is read in. */
export function Delta({ value, unit = 'bps' }) {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return null;
  const txt = unit === 'bps' ? bps(value * 10000, true)
    : unit === 'x' ? `${value > 0 ? '+' : ''}${value.toFixed(2)}`
    : `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
  return <span className={signClass(value)} style={{ fontSize: '10px', marginLeft: '5px' }}>
    {value > 0 ? '▲' : '▼'} {txt.replace('+', '').replace('-', '')}
  </span>;
}

export const fmtMetric = (value, format) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  switch (format) {
    case 'pct': return pct(value, 1);
    case 'x':   return mult(value);
    case 'bps': return bps(value);
    case '$':   return money(value);
    default:    return String(value);
  }
};
