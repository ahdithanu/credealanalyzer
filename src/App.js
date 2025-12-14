import React, { useState, useEffect } from 'react';
import { Plus, Calculator, BarChart3, Download, Settings, TrendingUp, DollarSign, Percent, Calendar, Building, Eye, Trash2, Copy, FileText, Target, PieChart, Activity, Car, Home, Store, Users, Hammer, Wrench } from 'lucide-react';

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

const formatNumber = (num) => {
  return new Intl.NumberFormat('en-US').format(num || 0);
};

const propertyTaxRates = {
  'houston, tx': 2.81,
  'houston': 2.81,
  'dallas, tx': 2.42,
  'dallas': 2.42,
  'austin, tx': 2.23,
  'austin': 2.23,
  'san antonio, tx': 2.34,
  'san antonio': 2.34,
  'fort worth, tx': 2.38,
  'fort worth': 2.38,
  'plano, tx': 2.15,
  'plano': 2.15,
  'arlington, tx': 2.33,
  'arlington': 2.33,
  'corpus christi, tx': 2.45,
  'corpus christi': 2.45,
  'lubbock, tx': 2.28,
  'lubbock': 2.28,
  'irving, tx': 2.41,
  'irving': 2.41,
  'miami, fl': 1.02,
  'miami': 1.02,
  'orlando, fl': 1.18,
  'orlando': 1.18,
  'tampa, fl': 1.23,
  'tampa': 1.23,
  'jacksonville, fl': 1.15,
  'jacksonville': 1.15,
  'fort lauderdale, fl': 1.04,
  'fort lauderdale': 1.04,
  'tallahassee, fl': 0.89,
  'tallahassee': 0.89,
  'gainesville, fl': 1.31,
  'gainesville': 1.31,
  'pensacola, fl': 0.95,
  'pensacola': 0.95,
  'clearwater, fl': 1.08,
  'clearwater': 1.08,
  'west palm beach, fl': 1.12,
  'west palm beach': 1.12,
  'texas': 2.35,
  'tx': 2.35,
  'florida': 1.08,
  'fl': 1.08
};

const getPropertyTaxRate = (location) => {
  if (!location) return 1.5;
  const locationLower = location.toLowerCase().trim();
  if (propertyTaxRates[locationLower]) {
    return propertyTaxRates[locationLower];
  }
  for (const city in propertyTaxRates) {
    if (locationLower.includes(city)) {
      return propertyTaxRates[city];
    }
  }
  return 1.5;
};

const propertyTypes = {
  carwash: {
    name: 'Car Wash',
    icon: Car,
    color: '#8b5cf6',
    avgRevenue: 150000,
    avgOpEx: 35,
    avgCapRate: 7.5,
    constructionCostPSF: { groundUp: 250, ti: 75 }
  },
  multifamily: {
    name: 'Multifamily',
    icon: Home,
    color: '#059669',
    avgRevenue: 12000,
    avgOpEx: 45,
    avgCapRate: 5.5,
    constructionCostPSF: { groundUp: 180, ti: 45 }
  },
  office: {
    name: 'Office',
    icon: Building,
    color: '#3b82f6',
    avgRevenue: 28,
    avgOpEx: 40,
    avgCapRate: 6.5,
    constructionCostPSF: { groundUp: 200, ti: 85 }
  },
  retail: {
    name: 'Retail',
    icon: Store,
    color: '#dc2626',
    avgRevenue: 22,
    avgOpEx: 38,
    avgCapRate: 7.0,
    constructionCostPSF: { groundUp: 175, ti: 65 }
  },
  industrial: {
    name: 'Industrial',
    icon: Users,
    color: '#ea580c',
    avgRevenue: 8,
    avgOpEx: 25,
    avgCapRate: 7.5,
    constructionCostPSF: { groundUp: 120, ti: 35 }
  }
};

const constructionTypes = {
  groundUp: {
    name: 'Ground-Up Development',
    icon: Hammer,
    timeframe: 18,
    riskMultiplier: 1.4,
    contingency: 0.15
  },
  ti: {
    name: 'Tenant Improvement',
    icon: Wrench,
    timeframe: 6,
    riskMultiplier: 1.1,
    contingency: 0.08
  },
  acquisition: {
    name: 'Acquisition/Renovation',
    icon: Building,
    timeframe: 12,
    riskMultiplier: 1.2,
    contingency: 0.10
  }
};

const calculateMetrics = (deal) => {
  const {
    propertyType,
    constructionType,
    purchasePrice = 0,
    constructionCost = 0,
    buildingSize = 0,
    units = 0,
    downPayment = 25,
    interestRate = 6.5,
    loanTerm = 25,
    grossRevenue = 0,
    vacancyRate = 5,
    operatingExpenseRatio = 35,
    exitCapRate = 6.5,
    holdPeriod = 5,
    location = ''
  } = deal;

  const totalProjectCost = purchasePrice + constructionCost;
  const propertyTaxRate = getPropertyTaxRate(location);
  const assessedValue = totalProjectCost;
  const annualPropertyTax = assessedValue * (propertyTaxRate / 100);
  const loanAmount = totalProjectCost * (1 - downPayment / 100);
  const downPaymentAmount = totalProjectCost * (downPayment / 100);
  const monthlyRate = interestRate / 100 / 12;
  const totalPayments = loanTerm * 12;
  
  const monthlyPayment = loanAmount > 0 && monthlyRate > 0 ? 
    loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, totalPayments)) / 
    (Math.pow(1 + monthlyRate, totalPayments) - 1) : 0;
  
  const annualDebtService = monthlyPayment * 12;
  const effectiveGrossRevenue = grossRevenue * (1 - vacancyRate / 100);
  const baseOperatingExpenses = effectiveGrossRevenue * (operatingExpenseRatio / 100);
  const totalOperatingExpenses = baseOperatingExpenses + annualPropertyTax;
  const noi = effectiveGrossRevenue - totalOperatingExpenses;
  const cashFlow = noi - annualDebtService;
  const cashOnCash = downPaymentAmount > 0 ? (cashFlow / downPaymentAmount) * 100 : 0;
  const capRate = totalProjectCost > 0 ? (noi / totalProjectCost) * 100 : 0;
  const dscr = annualDebtService > 0 ? noi / annualDebtService : 0;
  const exitValue = exitCapRate > 0 ? noi / (exitCapRate / 100) : totalProjectCost;
  const totalCashFlow = cashFlow * holdPeriod;
  const totalReturn = exitValue - totalProjectCost + totalCashFlow;
  const totalEquity = downPaymentAmount;
  const totalROI = totalEquity > 0 ? (totalReturn / totalEquity) * 100 : 0;
  const annualizedReturn = holdPeriod > 0 ? (Math.pow(1 + totalROI / 100, 1 / holdPeriod) - 1) * 100 : 0;
  const constructionTimeframe = constructionTypes[constructionType]?.timeframe || 12;
  const riskScore = (constructionTypes[constructionType]?.riskMultiplier || 1) * 
    (propertyType === 'carwash' ? 1.2 : propertyType === 'multifamily' ? 0.9 : 1.0);
  
  return {
    totalProjectCost,
    downPaymentAmount,
    loanAmount,
    monthlyPayment,
    annualDebtService,
    effectiveGrossRevenue,
    baseOperatingExpenses,
    annualPropertyTax,
    totalOperatingExpenses,
    propertyTaxRate,
    noi,
    cashFlow,
    cashOnCash,
    capRate,
    dscr,
    exitValue,
    totalReturn,
    totalROI,
    annualizedReturn,
    constructionTimeframe,
    riskScore
  };
};

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

  const getPlaceholderRevenue = () => {
    const type = propertyTypes[formData.propertyType];
    if (formData.propertyType === 'multifamily') {
      return type.avgRevenue * (formData.units || 50);
    } else {
      return type.avgRevenue * (formData.buildingSize || 5000) / 
        (formData.propertyType === 'carwash' ? 1 : formData.buildingSize || 5000);
    }
  };

  const getPlaceholderConstructionCost = () => {
    const type = propertyTypes[formData.propertyType];
    const costPSF = type.constructionCostPSF[formData.constructionType] || 150;
    return costPSF * (formData.buildingSize || 5000);
  };

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
            <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Operating Expense Ratio (%)</label>
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

  const getRiskColor = (riskScore) => {
    if (riskScore <= 1.0) return '#059669';
    if (riskScore <= 1.3) return '#d97706';
    return '#dc2626';
  };

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
            <option value="capRate">Cap Rate</option>
            <option value="dscr">DSCR</option>
            <option value="annualizedReturn">IRR</option>
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
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Cap Rate</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Cash on Cash</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>Total ROI</th>
                <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600' }}>IRR</th>
                <th style={{ padding: '12px', textAlign: 'center', fontWeight: '600' }}>Risk</th>
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
                        backgroundColor: `${getRiskColor(deal.metrics.riskScore)}20`,
                        color: getRiskColor(deal.metrics.riskScore)
                      }}>
                        {deal.metrics.riskScore.toFixed(1)}x
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

export default function CREDealAnalyzer() {
  const [deals, setDeals] = useState([]);
  const [selectedDeals, setSelectedDeals] = useState([]);
  const [currentView, setCurrentView] = useState('dashboard');
  const [editingDeal, setEditingDeal] = useState(null);

  useEffect(() => {
    const sampleDeals = [
      {
        id: 1,
        name: "Houston Express Car Wash",
        propertyType: "carwash",
        constructionType: "groundUp",
        location: "Houston, TX",
        purchasePrice: 500000,
        constructionCost: 1200000,
        buildingSize: 4800,
        grossRevenue: 580000,
        vacancyRate: 3,
        operatingExpenseRatio: 32,
        downPayment: 30,
        interestRate: 6.8,
        exitCapRate: 7.2
      },
      {
        id: 2,
        name: "Austin Multifamily Development",
        propertyType: "multifamily",
        constructionType: "groundUp",
        location: "Austin, TX",
        purchasePrice: 2500000,
        constructionCost: 8500000,
        buildingSize: 72000,
        units: 80,
        grossRevenue: 1920000,
        vacancyRate: 5,
        operatingExpenseRatio: 45,
        downPayment: 25,
        interestRate: 6.2,
        exitCapRate: 5.8
      },
      {
        id: 3,
        name: "Dallas Office TI Project",
        propertyType: "office",
        constructionType: "ti",
        location: "Dallas, TX",
        purchasePrice: 3200000,
        constructionCost: 850000,
        buildingSize: 25000,
        grossRevenue: 750000,
        vacancyRate: 8,
        operatingExpenseRatio: 40,
        downPayment: 20,
        interestRate: 5.9,
        exitCapRate: 6.5
      },
      {
        id: 4,
        name: "Miami Beach Car Wash",
        propertyType: "carwash",
        constructionType: "groundUp",
        location: "Miami, FL",
        purchasePrice: 800000,
        constructionCost: 1400000,
        buildingSize: 5200,
        grossRevenue: 720000,
        vacancyRate: 2,
        operatingExpenseRatio: 30,
        downPayment: 35,
        interestRate: 6.5,
        exitCapRate: 6.8
      },
      {
        id: 5,
        name: "Tampa Retail Center TI",
        propertyType: "retail",
        constructionType: "ti",
        location: "Tampa, FL",
        purchasePrice: 2800000,
        constructionCost: 650000,
        buildingSize: 18000,
        grossRevenue: 540000,
        vacancyRate: 6,
        operatingExpenseRatio: 38,
        downPayment: 25,
        interestRate: 6.1,
        exitCapRate: 7.0
      }
    ].map(deal => ({
      ...deal,
      metrics: calculateMetrics(deal)
    }));

    setDeals(sampleDeals);
  }, []);

  const handleSaveDeal = (dealData) => {
    if (dealData.id && deals.find(d => d.id === dealData.id)) {
      setDeals(deals.map(d => d.id === dealData.id ? dealData : d));
    } else {
      setDeals([...deals, { ...dealData, id: Date.now() }]);
    }
    setCurrentView('dashboard');
    setEditingDeal(null);
  };

  const handleDeleteDeal = (dealId) => {
    setDeals(deals.filter(d => d.id !== dealId));
    setSelectedDeals(selectedDeals.filter(id => id !== dealId));
  };

  const handleDuplicateDeal = (deal) => {
    const newDeal = {
      ...deal,
      id: Date.now(),
      name: `${deal.name} (Copy)`
    };
    setDeals([...deals, newDeal]);
  };

  const exportToCSV = () => {
    const headers = [
      'Deal Name', 'Property Type', 'Construction Type', 'Location',
      'Total Project Cost', 'NOI', 'Cash Flow', 'Cap Rate', 'Cash on Cash',
      'Total ROI', 'IRR', 'Risk Score', 'Construction Timeline'
    ];
    
    const rows = deals.map(deal => [
      deal.name,
      propertyTypes[deal.propertyType].name,
      constructionTypes[deal.constructionType].name,
      deal.location,
      deal.metrics.totalProjectCost,
      deal.metrics.noi,
      deal.metrics.cashFlow,
      deal.metrics.capRate,
      deal.metrics.cashOnCash,
      deal.metrics.totalROI,
      deal.metrics.annualizedReturn,
      deal.metrics.riskScore,
      deal.metrics.constructionTimeframe
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${cell}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cre-deal-analysis.csv';
    a.click();
    window.URL.revokeObjectURL(url);
  };

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
