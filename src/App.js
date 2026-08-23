import React, { useEffect, useMemo, useState } from 'react';
import { List, Calculator, Table, TrendingUp, Map, Plus, Download, AlertTriangle } from 'lucide-react';

import './ui/theme.css';
import { calculateMetrics } from './lib/finance';
import { loadDeals, saveDeals, isPersistenceAvailable } from './lib/storage';
import { SAMPLE_DEALS } from './lib/sampleDeals';
import { firmDefault } from './lib/firmDefaults';
import { propertyTypes } from './lib/propertyTypes';
import { exportDealsCSV } from './lib/exportCsv';

import Pipeline from './screens/Pipeline';
import DealModel from './screens/DealModel';
import CashFlow from './screens/CashFlow';
import Sensitivity from './screens/Sensitivity';
import MarketIntelligence from './screens/MarketIntelligence';

const VIEWS = [
  { key: 'pipeline', label: 'Pipeline',     Icon: List },
  { key: 'model',    label: 'Deal Model',   Icon: Calculator },
  { key: 'cashflow', label: 'Cash Flow',    Icon: Table },
  { key: 'sensitivity', label: 'Sensitivity', Icon: TrendingUp },
  { key: 'market',   label: 'Market Intel', Icon: Map },
];

/** Role decides the landing screen: analysts model, VPs triage. */
const ROLES = {
  analyst: { label: 'Rivera · Analyst', landing: 'model' },
  ic:      { label: 'Rivera · VP Investments', landing: 'pipeline' },
};

const withMetrics = (deals) =>
  (deals || []).map((d) => ({ ...d, metrics: calculateMetrics(d) }));

function blankDeal() {
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
  };
}

export default function App() {
  const [deals, setDeals] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [storageState, setStorageState] = useState({ available: true, error: null });
  const [role, setRole] = useState('ic');
  const [view, setView] = useState('pipeline');
  const [selectedId, setSelectedId] = useState(null);
  const [posture, setPosture] = useState('form');

  useEffect(() => {
    const { deals: saved, error } = loadDeals();
    setStorageState({ available: isPersistenceAvailable(), error });
    const initial = withMetrics(saved === null ? SAMPLE_DEALS : saved);
    setDeals(initial);
    setSelectedId(initial[0]?.id ?? null);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const { ok, error } = saveDeals(deals);
    if (!ok) setStorageState((s) => ({ ...s, error }));
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

  const notice = persistenceNotice(storageState);
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

        {notice && (
          <div className="notice"><AlertTriangle size={14} /><span>{notice}</span></div>
        )}

        <main className="content">
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
          ) : view === 'sensitivity' ? (
            <Sensitivity deal={selected} />
          ) : (
            <MarketIntelligence deal={selected} />
          )}
        </main>
      </div>
    </div>
  );
}

function persistenceNotice({ available, error }) {
  if (error === 'corrupt') {
    return 'Saved deals could not be read and have been set aside for recovery. Starting from the sample portfolio.';
  }
  if (error === 'quota') {
    return 'Browser storage is full. Recent changes are not being saved — export to CSV to avoid losing work.';
  }
  if (error || !available) {
    return 'Browser storage is unavailable, so deals will not persist when you close this tab. Export to CSV to keep your work.';
  }
  return null;
}
