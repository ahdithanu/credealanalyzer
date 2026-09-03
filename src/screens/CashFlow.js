import React, { useMemo, useState } from 'react';
import { Seg } from '../ui/components';
import { acct, monthLabel, NA } from '../lib/format';

const LINES = [
  { key: 'gpr',         label: 'Gross potential revenue' },
  { key: 'vacancy',     label: 'Vacancy / absorption loss', derived: (m) => -(m.gpr - m.egi) },
  { key: 'egi',         label: 'Effective gross income', subtotal: true },
  { key: 'recoveries',  label: 'Expense reimbursements' },
  { key: 'opex',        label: 'Operating expenses', negate: true },
  { key: 'tax',         label: 'Property tax', negate: true },
  { key: 'reserve',     label: 'Capital reserves', negate: true },
  { key: 'noi',         label: 'Net operating income', subtotal: true },
  { key: 'debtService', label: 'Debt service', negate: true },
  { key: 'cashFlow',    label: 'Cash flow', subtotal: true },
];

export default function CashFlow({ deal }) {
  const [mode, setMode] = useState('annual');
  const model = deal.metrics.model;
  const C = model.timeline.constructionMonths;
  // Month 0 is a real month — the closing — so an absent stabilization month
  // cannot fall back to a number. Unguarded, `Math.floor(null / 12)` is 0 and
  // the accent rule that marks stabilization was drawn on year one of a model
  // that never stabilised, beside a chip reading "Stabilizes month " with
  // nothing after it.
  const stabAt = model.operating.stabilizationMonth;
  const hasStab = Number.isFinite(stabAt);

  const periods = useMemo(() => {
    if (mode === 'monthly') {
      return model.months.map((m, i) => ({
        label: monthLabel(i),
        construction: i < C,
        stabilization: hasStab && i === stabAt,
        values: m,
      }));
    }
    return model.annual.map((y, i) => ({
      label: `Y${y.year}`,
      // A hold that is not a whole number of years leaves a stub period. Say so,
      // rather than letting a half-year read as a collapse in revenue.
      partial: y.partial,
      months: y.months,
      construction: (i + 1) * 12 <= C,
      stabilization: hasStab && i === Math.floor(stabAt / 12),
      values: y,
    }));
  }, [mode, model, C, stabAt, hasStab]);

  const cellValue = (line, values) => {
    if (line.derived) return line.derived(values);
    const v = values[line.key];
    if (v === undefined || v === null) return null;
    return line.negate ? -v : v;
  };

  let cumulative = 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span className="lbl">Cash flow · {mode} · $000s</span>
        <span className="spacer" />
        <span className="chip">Construction {Number.isFinite(C) ? `${C}mo` : NA}</span>
        <span className={`chip ${hasStab ? 'acc' : ''}`}>
          {hasStab ? `Stabilizes month ${stabAt}` : `Stabilization ${NA}`}
        </span>
        <Seg
          options={[{ value: 'annual', label: 'Annual' }, { value: 'monthly', label: 'Monthly' }]}
          value={mode}
          onChange={setMode}
        />
      </div>

      <div className="panel" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table className="grid" style={{ minWidth: 'max-content' }}>
          <thead>
            <tr>
              <th style={{ position: 'sticky', left: 0, zIndex: 3, background: 'var(--bg-raised)', minWidth: '210px' }}>
                Line item
              </th>
              {periods.map((p, i) => (
                <th
                  key={i}
                  className="r"
                  style={{
                    minWidth: '74px',
                    background: p.construction ? 'var(--sunken)' : 'var(--bg-raised)',
                    borderLeft: p.stabilization ? '1px solid var(--accent)' : undefined,
                  }}
                >
                  {p.label}
                  {p.partial && <span className="dim2" style={{ display: 'block', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{p.months}mo</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LINES.map((line) => (
              <tr key={line.key} className={line.subtotal ? 'total' : ''}>
                <td
                  style={{
                    position: 'sticky', left: 0, zIndex: 1,
                    background: 'var(--surface)',
                    fontWeight: line.subtotal ? 600 : 400,
                    color: line.subtotal ? 'var(--text)' : 'var(--text-2)',
                    borderTop: line.subtotal ? '1px solid var(--line-strong)' : undefined,
                  }}
                >
                  {line.label}
                </td>
                {periods.map((p, i) => {
                  const v = cellValue(line, p.values);
                  return (
                    <td
                      key={i}
                      className={`r num ${v !== null && v < 0 ? 'neg' : ''}`}
                      style={{
                        background: p.construction ? 'var(--sunken)' : undefined,
                        borderLeft: p.stabilization ? '1px solid var(--accent)' : undefined,
                        borderTop: line.subtotal ? '1px solid var(--line-strong)' : undefined,
                      }}
                    >
                      {v === null || v === undefined ? NA : acct(v / 1000)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td style={{ position: 'sticky', left: 0, background: 'var(--surface)', color: 'var(--text-3)' }}>
                Cumulative cash flow
              </td>
              {periods.map((p, i) => {
                cumulative += p.values.cashFlow || 0;
                return (
                  <td
                    key={i}
                    className={`r num ${cumulative < 0 ? 'neg' : ''}`}
                    style={{
                      background: p.construction ? 'var(--sunken)' : undefined,
                      borderLeft: p.stabilization ? '1px solid var(--accent)' : undefined,
                    }}
                  >
                    {acct(cumulative / 1000)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: '11px', color: 'var(--text-4)' }}>
        Sunken columns are the construction period. The accent rule marks stabilization.
        Figures in thousands; negatives in parentheses. Exit proceeds are excluded from
        the cash flow line and reported separately on the deal model.
      </div>
    </div>
  );
}
