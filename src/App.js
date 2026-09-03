import React, { useEffect, useMemo, useState } from 'react';
import { List, Calculator, Table, Split, TrendingUp, Map, FileText, Plus, Download, AlertTriangle } from 'lucide-react';

import './ui/theme.css';
import { calculateMetrics } from './lib/finance';
import { loadDeals, saveDeals, storageStatus } from './lib/storage';
import { promoteState } from './lib/waterfall';
import { SAMPLE_DEALS } from './lib/sampleDeals';
import { firmDefault } from './lib/firmDefaults';
import { propertyTypes } from './lib/propertyTypes';
import { exportDealsCSV } from './lib/exportCsv';

import Pipeline from './screens/Pipeline';
import DealModel from './screens/DealModel';
import CashFlow from './screens/CashFlow';
import Waterfall from './screens/Waterfall';
import Sensitivity from './screens/Sensitivity';
import MarketIntelligence from './screens/MarketIntelligence';
import ICMemo from './screens/ICMemo';

const VIEWS = [
  { key: 'pipeline', label: 'Pipeline',     Icon: List },
  { key: 'model',    label: 'Deal Model',   Icon: Calculator },
  { key: 'cashflow', label: 'Cash Flow',    Icon: Table },
  { key: 'waterfall', label: 'Waterfall',   Icon: Split },
  { key: 'sensitivity', label: 'Sensitivity', Icon: TrendingUp },
  { key: 'market',   label: 'Market Intel', Icon: Map },
  { key: 'memo',     label: 'IC Memo',      Icon: FileText },
];

/** Role decides the landing screen: analysts model, VPs triage. */
const ROLES = {
  analyst: { label: 'Rivera · Analyst', landing: 'model' },
  ic:      { label: 'Rivera · VP Investments', landing: 'pipeline' },
};

const withMetrics = (deals) =>
  (deals || []).map((d) => ({ ...d, metrics: calculateMetrics(d) }));

/**
 * A new, empty deal.
 *
 * Exported so the screen suite can render every screen against the exact object
 * the New deal button produces, rather than against a hand-written approximation
 * that drifts from it.
 */
export function blankDeal() {
  const propertyType = 'multifamily';
  const pick = (f) => firmDefault(f, propertyType);
  return {
    id: Date.now(),
    name: 'Untitled deal',
    stage: 'Screening',
    owner: 'Rivera',
    program: '—',
    propertyType,
    constructionType: 'groundUp',
    location: 'Dallas, TX',
    purchasePrice: 0,
    constructionCost: 0,
    buildingSize: 0,
    units: 0,
    grossRevenue: 0,
    vacancyRate: pick('vacancyRate'),
    operatingExpenseRatio: pick('operatingExpenseRatio'),
    downPayment: pick('downPayment'),
    interestRate: pick('interestRate'),
    loanTerm: pick('loanTerm'),
    exitCapRate: pick('exitCapRate'),
    holdPeriod: 5,
    // Stated, not omitted: a new deal has no promote structure, and every
    // surface reads that null as "these returns are before promote".
    waterfall: null,
  };
}

export default function App() {
  const [deals, setDeals] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  // Load and write failures are separate facts. Folding them into one `error`
  // meant a quota failure on save could never be cleared once the user deleted
  // deals to make room, and a corrupt-payload notice (about the load) was
  // overwritten by the next save's verdict.
  const [storageState, setStorageState] = useState({ available: true, loadError: null, writeError: null });
  const [role, setRole] = useState('ic');
  const [view, setView] = useState('pipeline');
  const [selectedId, setSelectedId] = useState(null);
  const [posture, setPosture] = useState('form');

  useEffect(() => {
    const { deals: saved, error } = loadDeals();
    setStorageState({ available: storageStatus() === 'available', loadError: error, writeError: null });
    const initial = withMetrics(saved === null ? SAMPLE_DEALS : saved);
    setDeals(initial);
    setSelectedId(initial[0]?.id ?? null);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const { ok, error } = saveDeals(deals);
    // Cleared on a successful write. A user who met a full quota and then
    // deleted deals to make room must stop being told their work is not saved.
    setStorageState((s) => ({ ...s, writeError: ok ? null : error }));
  }, [deals, hydrated]);

  const selected = useMemo(
    () => deals.find((d) => d.id === selectedId) ?? deals[0] ?? null,
    [deals, selectedId],
  );

  const updateDeal = (next) => {
    const withFresh = { ...next, metrics: calculateMetrics(next) };
    setDeals((cur) => cur.map((d) => (d.id === next.id ? withFresh : d)));
  };

  const openDeal = (deal) => {
    setSelectedId(deal.id);
    setView('model');
  };

  const newDeal = () => {
    const d = blankDeal();
    setDeals((cur) => [...cur, { ...d, metrics: calculateMetrics(d) }]);
    setSelectedId(d.id);
    setView('model');
  };

  const switchRole = (next) => {
    setRole(next);
    setView(ROLES[next].landing);
  };

  // Derived from the deals in hand, every render — not captured once at mount.
  // Held in state, the list kept naming a deal the analyst had already fixed on
  // the Waterfall screen (and one they had deleted) as unpromoted, while the
  // screen, the memo and the CSV all showed an applied split. A banner and a
  // page stating opposite facts about the same deal is the exact misreading
  // this notice exists to prevent. It is also the SAME predicate those three
  // surfaces run, so it cannot disagree with them by construction.
  const rejectedWaterfalls = useMemo(
    () => deals
      .map((d) => ({ deal: d, promote: promoteState(d.metrics?.model, d.waterfall) }))
      .filter(({ promote }) => promote.state === 'rejected')
      .map(({ deal, promote }) => ({ id: deal.id, name: deal.name ?? null, reason: promote.reason })),
    [deals],
  );

  const notices = statusNotices({ ...storageState, rejectedWaterfalls });
  const needsDeal = view !== 'pipeline' && !selected;

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-mark" title="CRE Deal Analyzer">CRE</div>
        {VIEWS.map(({ key, label, Icon }) => (
          <button
            key={key}
            className={`rail-btn ${view === key ? 'on' : ''}`}
            title={label}
            onClick={() => setView(key)}
          >
            <Icon size={16} />
          </button>
        ))}
        <span className="rail-sp" />
        <button className="rail-btn" title="New deal" onClick={newDeal}><Plus size={16} /></button>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1>{view === 'pipeline' ? 'Pipeline' : selected?.name ?? 'Deal Model'}</h1>
          {view !== 'pipeline' && selected && (
            <span className="sub">
              {selected.location} · {propertyTypes[selected.propertyType]?.name} · {selected.program}
            </span>
          )}
          {view !== 'pipeline' && selected && (
            <span className="chip">{selected.stage}</span>
          )}
          <span className="spacer" />
          {deals.length > 1 && view !== 'pipeline' && (
            <select
              className="inp"
              style={{ width: 'auto', height: '26px', fontSize: '11.5px' }}
              value={selected?.id ?? ''}
              onChange={(e) => setSelectedId(Number(e.target.value))}
            >
              {deals.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          <select
            className="inp"
            style={{ width: 'auto', height: '26px', fontSize: '11.5px' }}
            value={role}
            onChange={(e) => switchRole(e.target.value)}
          >
            {Object.entries(ROLES).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
          </select>
          <button className="btn" onClick={() => exportDealsCSV(deals)}>
            <Download size={13} /> Export
          </button>
          <button className="btn primary" onClick={newDeal}>
            <Plus size={13} /> New deal
          </button>
        </header>

        {notices.map((text) => (
          <div className="notice" key={text}><AlertTriangle size={14} /><span>{text}</span></div>
        ))}

        <main className={`content${view === "memo" ? " flush" : ""}`}>
          {!deals.length ? (
            <div className="empty">
              No deals yet. Create one to begin underwriting.
            </div>
          ) : needsDeal ? (
            <div className="empty">Select a deal from the pipeline.</div>
          ) : view === 'pipeline' ? (
            <Pipeline deals={deals} onOpen={openDeal} onExport={() => exportDealsCSV(deals)} />
          ) : view === 'model' ? (
            <DealModel deal={selected} onChange={updateDeal} posture={posture} onPosture={setPosture} />
          ) : view === 'cashflow' ? (
            <CashFlow deal={selected} />
          ) : view === 'waterfall' ? (
            <Waterfall deal={selected} onChange={updateDeal} />
          ) : view === 'sensitivity' ? (
            <Sensitivity deal={selected} />
          ) : view === 'market' ? (
            <MarketIntelligence deal={selected} />
          ) : (
            <ICMemo deal={selected} />
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * The banner text for whatever state persistence is in.
 *
 * Exported for the suite: the quota branch below was unreachable for the whole
 * life of this file — storage.js's availability probe wrote a key, so a full
 * quota failed the probe and every caller was told the facility was missing —
 * and a notice nobody can reach is not a notice.
 */
export function statusNotices({ available, loadError, writeError, rejectedWaterfalls }) {
  const out = [];
  if (loadError === 'corrupt') {
    out.push('Saved deals could not be read and have been set aside for recovery. Starting from the sample portfolio.');
  }
  // The write path is the authority on whether saving works — it is where the
  // browser actually refuses — and the load-time probe only stands in before
  // anything has been written. A full quota and an absent API need different
  // things from the reader (delete some deals, versus leave private browsing),
  // so they get different notices; storage.js is what tells them apart.
  const failure = writeError
    ?? (loadError === 'quota' ? 'quota' : null)
    ?? (available ? null : 'unavailable');
  if (failure === 'quota') {
    out.push('Browser storage is full. Recent changes are not being saved — delete deals you no longer need, or export to CSV to avoid losing work.');
  } else if (failure) {
    out.push('Browser storage is unavailable, so deals will not persist when you close this tab. Export to CSV to keep your work.');
  }
  // A promote structure the engine refuses splits nothing, and the deals
  // carrying one show pre-promote returns everywhere. Silence here would leave
  // an analyst reading project-level numbers on a deal they believe is
  // promoted, which is the one misreading this whole path exists to prevent.
  const rejected = rejectedWaterfalls ?? [];
  if (rejected.length) {
    const named = rejected.map((r) => `${r.name ?? 'a saved deal'} (${r.reason})`).join('; ');
    out.push(
      `${rejected.length === 1 ? 'A saved promote structure has' : `${rejected.length} saved promote structures have`}` +
      ` arithmetic the waterfall cannot run, so no split is applied on ${rejected.length === 1 ? 'that deal' : 'those deals'}` +
      ` and its returns are shown before promote: ${named}. Open the Waterfall screen to correct the structure.`
    );
  }
  return out;
}
