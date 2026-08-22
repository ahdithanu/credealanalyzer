import { propertyTypes, constructionTypes } from './propertyTypes';

const round = (n, dp = 0) =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(dp));

/**
 * Column names state the metric actually computed. The original export
 * labelled a CAGR-on-total-return figure as "IRR".
 */
export const COLUMNS = [
  ['Deal Name',                d => d.name],
  ['Stage',                    d => d.stage ?? ''],
  ['Owner',                    d => d.owner ?? ''],
  ['Property Type',            d => propertyTypes[d.propertyType]?.name ?? d.propertyType],
  ['Construction Type',        d => constructionTypes[d.constructionType]?.name ?? d.constructionType],
  ['Location',                 d => d.location],
  ['Total Development Cost ($)', d => round(d.metrics.totalProjectCost)],
  ['Capitalized Interest ($)', d => round(d.metrics.capitalizedInterest)],
  ['Equity Commitment ($)',    d => round(d.metrics.downPaymentAmount)],
  ['Peak Equity ($)',          d => round(d.metrics.peakEquity)],
  ['Stabilized NOI ($)',       d => round(d.metrics.noi)],
  ['Yield on Cost (%)',        d => round(d.metrics.yieldOnCost, 2)],
  ['Exit Cap Rate (%)',        d => d.exitCapRate],
  ['Development Spread (bps)', d => round(d.metrics.developmentSpreadBps)],
  ['Stabilized DSCR',          d => round(d.metrics.dscr, 2)],
  ['Min DSCR (stabilized)',    d => round(d.metrics.minStabilizedDSCR, 2)],
  ['Min DSCR (incl. lease-up)',d => round(d.metrics.minDSCR, 2)],
  ['Debt Yield (%)',           d => round(d.metrics.debtYield, 2)],
  ['Gross Sale Price ($)',     d => round(d.metrics.exitValue)],
  ['Net Sale Proceeds ($)',    d => round(d.metrics.netSaleProceeds)],
  ['Levered IRR (%)',          d => round(d.metrics.leveredIRR, 2)],
  ['Unlevered IRR (%)',        d => round(d.metrics.unleveredIRR, 2)],
  ['Equity Multiple (x)',      d => round(d.metrics.equityMultiple, 2)],
  ['Profit ($)',               d => round(d.metrics.profit)],
  ['Construction Months',      d => d.metrics.constructionTimeframe],
];

export function toCSV(deals) {
  const escape = (cell) => '"' + String(cell).replace(/"/g, '""') + '"';
  const rows = deals.map((d) => COLUMNS.map(([, get]) => {
    const v = get(d);
    return v === null || v === undefined ? 'n/a' : v;
  }));
  return [COLUMNS.map(([label]) => label), ...rows]
    .map((row) => row.map(escape).join(','))
    .join('\r\n');
}

export function exportDealsCSV(deals, filename = 'cre-deal-analysis.csv') {
  // Prefixed with a BOM so Excel reads it as UTF-8.
  const blob = new Blob(['﻿' + toCSV(deals)], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}
