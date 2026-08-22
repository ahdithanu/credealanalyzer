import React, { useState, useEffect } from 'react';
import { Plus, Calculator, Download, TrendingUp, DollarSign, Building, Eye, Trash2, Copy, Activity, AlertTriangle, Car, Home, Store, Users, Hammer, Wrench } from 'lucide-react';
import {
  propertyTypes as basePropertyTypes,
  constructionTypes as baseConstructionTypes,
  suggestGrossRevenue,
  suggestConstructionCost,
} from './lib/propertyTypes';
import { calculateMetrics } from './lib/finance';
import { getPropertyTaxRate } from './lib/markets';
import { loadDeals, saveDeals, isPersistenceAvailable } from './lib/storage';
import { SAMPLE_DEALS } from './lib/sampleDeals';

const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount || 0);
};

const formatPercent = (value) => {
  return `${(value || 0).toFixed(2)}%`;
};

// Domain configuration, the underwriting engine, market data and persistence all
// live in src/lib and are unit-tested there. This file is presentation only.
const propertyTypeIcons = {
  carwash: Car,
  multifamily: Home,
  office: Building,
  retail: Store,
  industrial: Users,
};

const constructionTypeIcons = {
  groundUp: Hammer,
  ti: Wrench,
  acquisition: Building,
};

const propertyTypes = Object.fromEntries(
  Object.entries(basePropertyTypes).map(([k, v]) => [k, { ...v, icon: propertyTypeIcons[k] }])
);

const constructionTypes = Object.fromEntries(
  Object.entries(baseConstructionTypes).map(([k, v]) => [k, { ...v, icon: constructionTypeIcons[k] }])
);


const DealInput = ({ deal, onSave, onCancel }) => {
  const [formData, setFormData] = useState({
    name: '',
    propertyType: 'carwash',
    constructionType: 'groundUp',
    purchasePrice: 0,
    constructionCost: 0,
    buildingSize: 0,
    units: 0,
    downPayment: 25,
    interestRate: 6.5,
    loanTerm: 25,
    grossRevenue: 0,
    vacancyRate: 5,
    operatingExpenseRatio: 35,
    exitCapRate: 6.5,
    holdPeriod: 5,
    location: '',
    notes: '',
    ...deal
  });

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    const metrics = calculateMetrics(formData);
    onSave({ ...formData, metrics, id: deal?.id || Date.now() });
  };

  const getPlaceholderRevenue = () => suggestGrossRevenue(formData);

  const getPlaceholderConstructionCost = () => suggestConstructionCost(formData);

  const inputStyle = {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '14px'
  };

  const cardStyle = {
    backgroundColor: 'white',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    padding: '24px',
    marginBottom: '20px'
  };

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto' }}>
      <div style={cardStyle}>
        <h2 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '24px' }}>
          {deal ? 'Edit Deal' : 'New Deal Analysis'}
        </h2>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Deal Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="e.g., Downtown Car Wash Development"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Location</label>
            <input
              type="text"
              value={formData.location}
              onChange={(e) => handleChange('location', e.target.value)}
              placeholder="e.g., Houston, TX"
              style={inputStyle}
            />
            {formData.location && (
              <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
                Property Tax Rate: {getPropertyTaxRate(formData.location).toFixed(2)}% annually
                ({formatCurrency((formData.purchasePrice + formData.constructionCost) * getPropertyTaxRate(formData.location) / 100)}/year)
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Property Type</label>
            <select
              value={formData.propertyType}
              onChange={(e) => handleChange('propertyType', e.target.value)}
              style={inputStyle}
            >
              {Object.entries(propertyTypes).map(([key, type]) => (
                <option key={key} value={key}>{type.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Construction Type</label>
            <select
              value={formData.constructionType}
              onChange={(e) => handleChange('constructionType', e.target.value)}
              style={inputStyle}
            >
              {Object.entries(constructionTypes).map(([key, type]) => (
                <option key={key} value={key}>{type.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '24px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
              {formData.constructionType === 'groundUp' ? 'Land Price' : 'Purchase Price'}
            </label>
            <input
              type="number"
              value={formData.purchasePrice}
              onChange={(e) => handleChange('purchasePrice', Number(e.target.value))}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
              Construction Cost
            </label>
            <input
              type="number"
              value={formData.constructionCost}
              onChange={(e) => handleChange('constructionCost', Number(e.target.value))}
              placeholder={getPlaceholderConstructionCost().toLocaleString()}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
              Building Size (SF)
            </label>
            <input
              type="number"
              value={formData.buildingSize}
              onChange={(e) => handleChange('buildingSize', Number(e.target.value))}
              style={inputStyle}
            />
          </div>
        </div>

        {formData.propertyType === 'multifamily' && (
          <div style={{ marginBottom: '24px' }}>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Number of Units</label>
            <input
              type="number"
              value={formData.units}
              onChange={(e) => handleChange('units', Number(e.target.value))}
              style={{ ...inputStyle, width: '200px' }}
            />
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '24px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Annual Gross Revenue</label>
            <input
              type="number"
              value={formData.grossRevenue}
              onChange={(e) => handleChange('grossRevenue', Number(e.target.value))}
              placeholder={getPlaceholderRevenue().toLocaleString()}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Vacancy Rate (%)</label>
            <input
              type="number"
              step="0.1"
              value={formData.vacancyRate}
              onChange={(e) => handleChange('vacancyRate', Number(e.target.value))}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Operating Expense Ratio (%, excl. property tax)</label>
            <input
              type="number"
              step="0.1"
              value={formData.operatingExpenseRatio}
              onChange={(e) => handleChange('operatingExpenseRatio', Number(e.target.value))}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '24px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Down Payment (%)</label>
            <input
              type="number"
              step="0.1"
              value={formData.downPayment}
              onChange={(e) => handleChange('downPayment', Number(e.target.value))}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Interest Rate (%)</label>
            <input
              type="number"
              step="0.1"
              value={formData.interestRate}
              onChange={(e) => handleChange('interestRate', Number(e.target.value))}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Exit Cap Rate (%)</label>
            <input
              type="number"
              step="0.1"
              value={formData.exitCapRate}
              onChange={(e) => handleChange('exitCapRate', Number(e.target.value))}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ marginBottom: '24px' }}>
          <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Notes</label>
          <textarea
            value={formData.notes}
            onChange={(e) => handleChange('notes', e.target.value)}
            placeholder="Additional notes about this deal..."
            style={{ ...inputStyle, height: '80px', resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '10px 20px',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              backgroundColor: 'white',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              padding: '10px 20px',
              border: 'none',
              borderRadius: '6px',
              backgroundColor: '#3b82f6',
              color: 'white',
              cursor: 'pointer',
              fontWeight: '500'
            }}
          >
            Save Deal
          </button>
        </div>
      </div>
    </div>
  );
};

const DealComparison = ({ deals, selectedDeals, onSelectionChange }) => {
  const [sortBy, setSortBy] = useState('totalROI');
  const [filterPropertyType, setFilterPropertyType] = useState('all');
  const [filterConstructionType, setFilterConstructionType] = useState('all');

  const filteredDeals = deals.filter(deal => {
    const propertyMatch = filterPropertyType === 'all' || deal.propertyType === filterPropertyType;
    const constructionMatch = filterConstructionType === 'all' || deal.constructionType === filterConstructionType;
    return propertyMatch && constructionMatch;
  });

  const sortedDeals = [...filteredDeals].sort((a, b) => {
    const aValue = a.metrics[sortBy] || 0;
    const bValue = b.metrics[sortBy] || 0;
    return bValue - aValue;
  });

  const cardStyle = {
    backgroundColor: 'white',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    padding: '24px',
    marginBottom: '20px'
  };

  // Minimum DSCR across any rolling operating year, banded against a typical
  // 1.25x lender covenant. This replaces the previous "risk score", which was
  // an undocumented multiplier with no stated methodology.
  const getDSCRColor = (dscr) => {
    if (dscr === null || dscr === undefined) return '#6b7280';
    if (dscr >= 1.35) return '#059669';
    if (dscr >= 1.25) return '#d97706';
    return '#dc2626';
  };

  const formatDSCR = (dscr) =>
    dscr === null || dscr === undefined || !Number.isFinite(dscr) ? 'n/a' : `${dscr.toFixed(2)}x`;

  const getROIColor = (roi) => {
    if (roi >= 20) return '#059669';
    if (roi >= 10) return '#d97706';
    return '#dc2626';
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600', margin: 0 }}>Deal Comparison</h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <select
            value={filterPropertyType}
            onChange={(e) => setFilterPropertyType(e.target.value)}
            style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '4px' }}
          >
            <option value="all">All Property Types</option>
            {Object.entries(propertyTypes).map(([key, type]) => (
              <option key={key} value={key}>{type.name}</option>
            ))}
          </select>
          <select
            value={filterConstructionType}
            onChange={(e) => setFilterConstructionType(e.target.value)}
            style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '4px' }}
          >
            <option value="all">All Construction Types</option>
            {Object.entries(constructionTypes).map(([key, type]) => (
              <option key={key} value={key}>{type.name}</option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '4px' }}
          >
            <option value="totalROI">Total ROI</option>
            <option value="cashOnCash">Cash on Cash</option>
            <option value="capRate">Yield on Cost</option>
            <option value="dscr">DSCR</option>
            <option value="annualizedReturn">Levered IRR</option>
          </select>
        </div>
      </div>

      {sortedDeals.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#6b7280' }}>
          No deals match the selected filters
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600' }}>Deal</th>
                <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>Type</th>
                <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>Construction</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Total Cost</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>NOI</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Property Tax</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Cash Flow</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Yield on Cost</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Cash on Cash</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Total ROI</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Levered IRR</th>
                <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>Min DSCR</th>
                <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>Timeline</th>
              </tr>
            </thead>
            <tbody>
              {sortedDeals.map((deal, index) => {
                const PropertyIcon = propertyTypes[deal.propertyType].icon;
                const ConstructionIcon = constructionTypes[deal.constructionType].icon;
                
                return (
                  <tr 
                    key={deal.id}
                    onClick={() => {
                      const newSelection = selectedDeals.includes(deal.id)
                        ? selectedDeals.filter(id => id !== deal.id)
                        : [...selectedDeals, deal.id];
                      onSelectionChange(newSelection);
                    }}
                    style={{ 
                      borderBottom: '1px solid #f3f4f6',
                      backgroundColor: selectedDeals.includes(deal.id) ? '#eff6ff' : index % 2 === 0 ? '#fafafa' : 'white',
                      cursor: 'pointer'
                    }}
                  >
                    <td style={{ padding: '12px' }}>
                      <div style={{ fontWeight: '600', marginBottom: '4px' }}>{deal.name}</div>
                      <div style={{ fontSize: '12px', color: '#6b7280' }}>{deal.location}</div>
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                        <PropertyIcon size={16} style={{ color: propertyTypes[deal.propertyType].color }} />
                        <span style={{ fontSize: '12px' }}>{propertyTypes[deal.propertyType].name}</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                        <ConstructionIcon size={16} style={{ color: '#6b7280' }} />
                        <span style={{ fontSize: '12px' }}>
                          {deal.constructionType === 'groundUp' ? 'Ground-Up' : 
                           deal.constructionType === 'ti' ? 'TI' : 'Acquisition'}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right', fontWeight: '500' }}>
                      {formatCurrency(deal.metrics.totalProjectCost)}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right', fontWeight: '500' }}>
                      {formatCurrency(deal.metrics.noi)}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right' }}>
                      <div style={{ fontSize: '14px', fontWeight: '500' }}>{formatCurrency(deal.metrics.annualPropertyTax)}</div>
                      <div style={{ fontSize: '11px', color: '#6b7280' }}>{deal.metrics.propertyTaxRate.toFixed(2)}%</div>
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right', fontWeight: '500' }}>
                      {formatCurrency(deal.metrics.cashFlow)}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right', fontWeight: '500' }}>
                      {formatPercent(deal.metrics.capRate)}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right', fontWeight: '500' }}>
                      {formatPercent(deal.metrics.cashOnCash)}
                    </td>
                    <td style={{ 
                      padding: '12px', 
                      textAlign: 'right', 
                      fontWeight: '600',
                      color: getROIColor(deal.metrics.totalROI)
                    }}>
                      {formatPercent(deal.metrics.totalROI)}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right', fontWeight: '500' }}>
                      {formatPercent(deal.metrics.annualizedReturn)}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: '12px',
                        fontSize: '11px',
                        fontWeight: '600',
                        backgroundColor: `${getDSCRColor(deal.metrics.minDSCR)}20`,
                        color: getDSCRColor(deal.metrics.minDSCR)
                      }}>
                        {formatDSCR(deal.metrics.minDSCR)}
                      </span>
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center', fontSize: '12px' }}>
                      {deal.metrics.constructionTimeframe}mo
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const round = (n, dp = 0) =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(dp));

const withMetrics = (deals) =>
  (deals || []).map((deal) => ({ ...deal, metrics: calculateMetrics(deal) }));

export default function CREDealAnalyzer() {
  const [deals, setDeals] = useState([]);
  const [selectedDeals, setSelectedDeals] = useState([]);
  const [currentView, setCurrentView] = useState('dashboard');
  const [editingDeal, setEditingDeal] = useState(null);
  const [hydrated, setHydrated] = useState(false);

  const [storageState, setStorageState] = useState({ available: true, error: null });

  // Load persisted deals once. A stored empty array means the user deleted
  // everything and must not be re-seeded; only a total absence of saved state
  // seeds the samples.
  useEffect(() => {
    const { deals: saved, error } = loadDeals();
    setStorageState({ available: isPersistenceAvailable(), error });
    setDeals(withMetrics(saved === null ? SAMPLE_DEALS : saved));
    setHydrated(true);
  }, []);

  // Persist on every change, but only after hydration, so the initial empty
  // state can never overwrite saved deals.
  useEffect(() => {
    if (!hydrated) return;
    const { ok, error } = saveDeals(deals);
    if (!ok) setStorageState((s) => ({ ...s, error }));
  }, [deals, hydrated]);


  const handleSaveDeal = (dealData) => {
    const withFresh = { ...dealData, metrics: calculateMetrics(dealData) };
    if (dealData.id && deals.find(d => d.id === dealData.id)) {
      setDeals(deals.map(d => d.id === dealData.id ? withFresh : d));
    } else {
      setDeals([...deals, { ...withFresh, id: Date.now() }]);
    }
    setCurrentView('dashboard');
    setEditingDeal(null);
  };

  const handleDeleteDeal = (dealId) => {
    setDeals(deals.filter(d => d.id !== dealId));
    setSelectedDeals(selectedDeals.filter(id => id !== dealId));
  };

  const handleDuplicateDeal = (deal) => {
    const copy = { ...deal, id: Date.now(), name: `${deal.name} (Copy)` };
    setDeals([...deals, { ...copy, metrics: calculateMetrics(copy) }]);
  };

  const exportToCSV = () => {
    // Column names state the metric actually computed. The previous export
    // labelled a CAGR-on-total-return figure as "IRR".
    const columns = [
      ['Deal Name',              d => d.name],
      ['Property Type',          d => propertyTypes[d.propertyType]?.name ?? d.propertyType],
      ['Construction Type',      d => constructionTypes[d.constructionType]?.name ?? d.constructionType],
      ['Location',               d => d.location],
      ['Total Project Cost ($)', d => round(d.metrics.totalProjectCost)],
      ['Capitalized Interest ($)', d => round(d.metrics.capitalizedInterest)],
      ['Equity ($)',             d => round(d.metrics.downPaymentAmount)],
      ['Peak Equity ($)',        d => round(d.metrics.peakEquity)],
      ['Stabilized NOI ($)',     d => round(d.metrics.noi)],
      ['Yield on Cost (%)',      d => round(d.metrics.yieldOnCost, 2)],
      ['Exit Cap Rate (%)',      d => d.exitCapRate],
      ['Development Spread (bps)', d => round(d.metrics.developmentSpreadBps)],
      ['Stabilized DSCR',        d => round(d.metrics.dscr, 2)],
      ['Minimum DSCR',           d => round(d.metrics.minDSCR, 2)],
      ['Debt Yield (%)',         d => round(d.metrics.debtYield, 2)],
      ['Gross Sale Price ($)',   d => round(d.metrics.exitValue)],
      ['Net Sale Proceeds ($)',  d => round(d.metrics.netSaleProceeds)],
      ['Levered IRR (%)',        d => round(d.metrics.leveredIRR, 2)],
      ['Unlevered IRR (%)',      d => round(d.metrics.unleveredIRR, 2)],
      ['Equity Multiple (x)',    d => round(d.metrics.equityMultiple, 2)],
      ['Profit ($)',             d => round(d.metrics.profit)],
      ['Construction Months',    d => d.metrics.constructionTimeframe],
    ];

    const rows = deals.map(d => columns.map(([, get]) => {
      const v = get(d);
      return v === null || v === undefined ? 'n/a' : v;
    }));

    const escape = (cell) => '"' + String(cell).replace(/"/g, '""') + '"';
    const csvContent = [columns.map(([label]) => label), ...rows]
      .map(row => row.map(escape).join(','))
      .join('\r\n');

    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cre-deal-analysis.csv';
    a.click();
    window.URL.revokeObjectURL(url);
  };


  const persistenceNotice = (() => {
    if (storageState.error === 'corrupt') {
      return 'Saved deals could not be read and have been set aside for recovery. Starting from the sample portfolio.';
    }
    if (storageState.error === 'quota') {
      return 'Browser storage is full. Recent changes are not being saved. Export to CSV to avoid losing work.';
    }
    if (storageState.error || !storageState.available) {
      return 'Browser storage is unavailable, so deals will not persist when you close this tab. Export to CSV to keep your work.';
    }
    return null;
  })();

  const noticeBar = persistenceNotice ? (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '10px 24px', backgroundColor: '#fef3c7',
      borderBottom: '1px solid #fcd34d', color: '#92400e', fontSize: '13px'
    }}>
      <AlertTriangle size={16} />
      <span>{persistenceNotice}</span>
    </div>
  ) : null;

  const containerStyle = {
    minHeight: '100vh',
    backgroundColor: '#f8fafc'
  };

  const headerStyle = {
    backgroundColor: 'white',
    borderBottom: '1px solid #e5e7eb',
    padding: '16px 24px'
  };

  const buttonStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '500'
  };

  const primaryButtonStyle = {
    ...buttonStyle,
    backgroundColor: '#3b82f6',
    color: 'white'
  };

  const secondaryButtonStyle = {
    ...buttonStyle,
    backgroundColor: 'white',
    color: '#374151',
    border: '1px solid #d1d5db'
  };

  if (currentView === 'input') {
    return (
      <div style={containerStyle}>
        {noticeBar}
        <div style={headerStyle}>
          <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h1 style={{ fontSize: '24px', fontWeight: '700', margin: 0 }}>Commercial Real Estate Deal Analyzer</h1>
            <button
              onClick={() => setCurrentView('dashboard')}
              style={secondaryButtonStyle}
            >
              Back to Dashboard
            </button>
          </div>
        </div>
        <div style={{ padding: '24px' }}>
          <DealInput
            deal={editingDeal}
            onSave={handleSaveDeal}
            onCancel={() => {
              setCurrentView('dashboard');
              setEditingDeal(null);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {noticeBar}
      <div style={headerStyle}>
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 style={{ fontSize: '28px', fontWeight: '700', margin: '0 0 4px 0' }}>
                Commercial Real Estate Deal Analyzer
              </h1>
              <p style={{ color: '#6b7280', margin: 0 }}>
                Analyze and compare CRE development opportunities with precision
              </p>
            </div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={() => setCurrentView('input')}
                style={primaryButtonStyle}
              >
                <Plus size={16} />
                New Deal
              </button>
              <button
                onClick={exportToCSV}
                style={secondaryButtonStyle}
                disabled={deals.length === 0}
              >
                <Download size={16} />
                Export CSV
              </button>
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginBottom: '24px' }}>
          <div style={{ 
            backgroundColor: 'white', 
            padding: '20px', 
            borderRadius: '8px', 
            border: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            gap: '16px'
          }}>
            <div style={{ 
              backgroundColor: '#dbeafe', 
              padding: '12px', 
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <Calculator size={24} style={{ color: '#3b82f6' }} />
            </div>
            <div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: '#1f2937' }}>{deals.length}</div>
              <div style={{ fontSize: '14px', color: '#6b7280' }}>Total Deals</div>
            </div>
          </div>

          <div style={{ 
            backgroundColor: 'white', 
            padding: '20px', 
            borderRadius: '8px', 
            border: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            gap: '16px'
          }}>
            <div style={{ 
              backgroundColor: '#dcfce7', 
              padding: '12px', 
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <DollarSign size={24} style={{ color: '#059669' }} />
            </div>
            <div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: '#1f2937' }}>
                {formatCurrency(deals.reduce((sum, deal) => sum + deal.metrics.totalProjectCost, 0))}
              </div>
              <div style={{ fontSize: '14px', color: '#6b7280' }}>Total Investment</div>
            </div>
          </div>

          <div style={{ 
            backgroundColor: 'white', 
            padding: '20px', 
            borderRadius: '8px', 
            border: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            gap: '16px'
          }}>
            <div style={{ 
              backgroundColor: '#fef3c7', 
              padding: '12px', 
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <TrendingUp size={24} style={{ color: '#d97706' }} />
            </div>
            <div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: '#1f2937' }}>
                {deals.length > 0 ? 
                  formatPercent(deals.reduce((sum, deal) => sum + deal.metrics.totalROI, 0) / deals.length) : 
                  '0%'
                }
              </div>
              <div style={{ fontSize: '14px', color: '#6b7280' }}>Avg Total ROI</div>
            </div>
          </div>

          <div style={{ 
            backgroundColor: 'white', 
            padding: '20px', 
            borderRadius: '8px', 
            border: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            gap: '16px'
          }}>
            <div style={{ 
              backgroundColor: '#fce7f3', 
              padding: '12px', 
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <Activity size={24} style={{ color: '#be185d' }} />
            </div>
            <div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: '#1f2937' }}>
                {formatCurrency(deals.reduce((sum, deal) => sum + deal.metrics.noi, 0))}
              </div>
              <div style={{ fontSize: '14px', color: '#6b7280' }}>Total NOI</div>
            </div>
          </div>
        </div>

        <DealComparison 
          deals={deals}
          selectedDeals={selectedDeals}
          onSelectionChange={setSelectedDeals}
        />

        {selectedDeals.length > 0 && (
          <div style={{
            backgroundColor: 'white',
            borderRadius: '8px',
            border: '1px solid #e5e7eb',
            padding: '16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div style={{ fontSize: '14px', color: '#6b7280' }}>
              {selectedDeals.length} deal{selectedDeals.length > 1 ? 's' : ''} selected
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {selectedDeals.length === 1 && (
                <>
                  <button
                    onClick={() => {
                      const deal = deals.find(d => d.id === selectedDeals[0]);
                      setEditingDeal(deal);
                      setCurrentView('input');
                    }}
                    style={{ ...secondaryButtonStyle, padding: '8px 12px' }}
                  >
                    <Eye size={14} />
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      const deal = deals.find(d => d.id === selectedDeals[0]);
                      handleDuplicateDeal(deal);
                    }}
                    style={{ ...secondaryButtonStyle, padding: '8px 12px' }}
                  >
                    <Copy size={14} />
                    Duplicate
                  </button>
                </>
              )}
              <button
                onClick={() => {
                  selectedDeals.forEach(handleDeleteDeal);
                  setSelectedDeals([]);
                }}
                style={{ 
                  ...buttonStyle, 
                  padding: '8px 12px',
                  backgroundColor: '#dc2626',
                  color: 'white'
                }}
              >
                <Trash2 size={14} />
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
