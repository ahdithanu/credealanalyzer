import React, { useMemo, useRef, useState } from 'react';
import { Printer, FileDown } from 'lucide-react';
import { buildMemo } from '../lib/memo';

/**
 * The IC memorandum: an outline rail, document pages on a desk ground, and a
 * page thumbnail strip — wireframes 1r and 1s.
 *
 * The sheets render on paper rather than on the dark app surface. What gets
 * circulated is printed or a PDF, so the preview shows the artifact as it will
 * actually leave the building. Export is the browser's own print pipeline: it
 * produces correct pagination and selectable text, which a canvas-to-PDF
 * library does not.
 */
export default function ICMemo({ deal }) {
  const [active, setActive] = useState(1);
  const deskRef = useRef(null);
  const memo = useMemo(() => buildMemo(deal), [deal]);

  const goto = (n) => {
    setActive(n);
    const el = deskRef.current?.querySelector(`[data-page="${n}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <aside
        className="memo-outline no-print"
        style={{ width: '188px', flex: 'none', borderRight: '1px solid var(--line)', padding: '14px 12px', overflow: 'auto' }}
      >
        <div className="lbl" style={{ marginBottom: '10px' }}>Sections</div>
        {memo.pages.map((p) => (
          <button
            key={p.n}
            className={`btn ghost ${active === p.n ? 'on' : ''}`}
            style={{ width: '100%', height: 'auto', minHeight: '26px', padding: '5px 8px', marginBottom: '3px', justifyContent: 'flex-start', textAlign: 'left', fontSize: '11.5px', lineHeight: 1.3 }}
            onClick={() => goto(p.n)}
          >
            <span className="dim2" style={{ width: '13px', flex: 'none' }}>{p.n}</span>
            <span>{p.title}</span>
          </button>
        ))}

        <div className="lbl" style={{ margin: '20px 0 8px' }}>Provenance</div>
        <Prov k="Figures computed" v={memo.provenance.modelFigureCount} />
        <Prov k="Assumption set" v={memo.provenance.assumptionSet} />
        <Prov k="Overrides" v={memo.provenance.overrides} />
        <Prov k="Open flags" v={memo.provenance.flags} />
        <Prov k="Market data" v={memo.provenance.marketDataQuality} warn />
        <div style={{ fontSize: '10px', color: 'var(--text-4)', marginTop: '10px', lineHeight: 1.45 }}>
          Every figure is computed from the live model at generation time. None is transcribed.
        </div>
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
          <span className="lbl">IC memo</span>
          <span className="chip">{memo.meta.pageCount} pages</span>
          <span className={`chip ${memo.screen.failedCount ? 'warn' : 'pos'}`}>{memo.screen.verdict}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => window.print()}><Printer size={13} /> Print</button>
          <button className="btn primary" onClick={() => window.print()}><FileDown size={13} /> Save as PDF</button>
        </div>

        <div className="desk" ref={deskRef}>
          {memo.pages.map((page) => (
            <Sheet key={page.n} page={page} meta={memo.meta} />
          ))}
        </div>

        <div className="thumbs no-print">
          {memo.pages.map((p) => (
            <div key={p.n} className={`thumb ${active === p.n ? 'on' : ''}`} onClick={() => goto(p.n)} title={p.title}>
              {p.n}
            </div>
          ))}
          <div style={{ alignSelf: 'center', marginLeft: '8px', fontSize: '10.5px', color: 'var(--text-4)' }}>
            {memo.meta.dealName} · prepared by {memo.meta.preparedBy} ·{' '}
            {memo.meta.date.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Prov({ k, v, warn }) {
  return (
    <div style={{ display: 'flex', gap: '8px', fontSize: '10.5px', padding: '2px 0' }}>
      <span className="dim2">{k}</span>
      <span className="spacer" />
      <span className={warn ? 'warnc' : 'dim'} style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  );
}

function Sheet({ page, meta }) {
  return (
    <section className="sheet" data-page={page.n}>
      <header className="doc-hd">
        <div className="mark">CRE</div>
        <div>
          <div className="doc-title">{meta.title}</div>
          <div className="doc-sub">
            {meta.dealName} · {meta.location} · {meta.stage}
          </div>
        </div>
        <div className="doc-conf">
          Confidential
          <div style={{ color: '#8a8a94', letterSpacing: 0, textTransform: 'none', marginTop: '2px' }}>
            {meta.date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
        </div>
      </header>

      <h2>{page.n}. {page.title}</h2>

      {page.blocks.map((block, i) => <Block key={i} block={block} />)}

      <footer className="doc-ft">
        <span>{meta.dealName} · prepared by {meta.preparedBy}</span>
        <span style={{ marginLeft: 'auto' }}>Page {page.n} of {meta.pageCount}</span>
      </footer>
    </section>
  );
}

function Block({ block }) {
  switch (block.type) {
    case 'facts':
      return (
        <div className="facts">
          {block.items.map((it) => (
            <div key={it.label}><div className="k">{it.label}</div><div className="v">{it.value}</div></div>
          ))}
        </div>
      );

    case 'headline':
      return (
        <div className="headline">
          {block.items.map((it) => (
            <div key={it.label}><div className="k">{it.label}</div><div className="v">{it.value}</div></div>
          ))}
        </div>
      );

    case 'verdict':
      return (
        <div className={`verdict ${block.pass ? '' : 'fail'}`}>
          <div className="vt">{block.verdict}</div>
          <div className="vs">{block.summary}</div>
          <div className="tests">
            {block.tests.map((t) => (
              <div className="t" key={t.label}>
                <div className="tl">{t.label}</div>
                <div className={`tv ${t.pass ? '' : 'no'}`}>{t.actual}</div>
                <div className="th2">{t.threshold}</div>
              </div>
            ))}
          </div>
        </div>
      );

    case 'table':
      return (
        <>
          {block.title && <h3>{block.title}</h3>}
          <table>
            <thead>
              <tr>{block.headers.map((h, i) => (
                <th key={h + i} className={block.align?.[i] === 'r' ? 'r' : ''}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>{row.map((cell, ci) => (
                  <td key={ci} className={block.align?.[ci] === 'r' ? 'r' : ''}>{cell}</td>
                ))}</tr>
              ))}
              {block.total && (
                <tr className="total">{block.total.map((cell, ci) => (
                  <td key={ci} className={block.align?.[ci] === 'r' ? 'r' : ''}>{cell}</td>
                ))}</tr>
              )}
            </tbody>
          </table>
        </>
      );

    case 'matrix':
      return (
        <>
          {block.title && <h3>{block.title}</h3>}
          <table className="matrix">
            <thead>
              <tr>
                <th />
                {block.xLabels.map((x) => <th key={x} className="r">{x}</th>)}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  <td style={{ fontWeight: 600 }}>{block.yLabels[ri]}</td>
                  {row.map((cell, ci) => (
                    <td key={ci} className={`c ${block.centre && ri === block.centre[0] && ci === block.centre[1] ? 'mid' : ''}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );

    case 'flags':
      return (
        <>
          {block.title && <h3>{block.title}</h3>}
          {block.flags.length === 0
            ? <div className="note" style={{ border: 0, marginTop: 0, paddingTop: 0 }}>No validation flags.</div>
            : block.flags.map((f, i) => (
              <div className="memo-flag" key={i}>
                <span className={`d ${f.severity}`} />
                <div><span className="ft">{f.title}</span> <span className="fd">{f.detail}</span></div>
              </div>
            ))}
        </>
      );

    case 'disclosure':
      return (
        <>
          <h3>{block.title}</h3>
          <ol className="disc">
            {block.items.map((t, i) => <li key={i}>{t}</li>)}
          </ol>
        </>
      );

    case 'note':
      return (
        <div className="note">
          {block.title && <span className="nt">{block.title}</span>}
          {block.text}
        </div>
      );

    default:
      return null;
  }
}
