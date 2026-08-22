/**
 * Display formatting.
 *
 * Every helper renders a missing or non-finite value as 'n/a' rather than 0.
 * A zero and an unknown are different claims, and an underwriting screen that
 * conflates them is lying to the reader.
 */

const bad = (n) => n === null || n === undefined || !Number.isFinite(n);

export const NA = 'n/a';

/** Compact currency: $84.2M, $840K, $1,240 */
export function money(n, dp = 1) {
  if (bad(n)) return NA;
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(dp)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(dp)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return `${sign}$${Math.round(a)}`;
}

/** Full currency with separators: $84,240 */
export function money0(n) {
  if (bad(n)) return NA;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/** Thousands of dollars, as a bare number: 84,240 */
export function thousands(n) {
  if (bad(n)) return NA;
  return Math.round(n / 1000).toLocaleString('en-US');
}

export function num(n, dp = 0) {
  if (bad(n)) return NA;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Ratio to percent: 0.194 -> 19.4% */
export function pct(n, dp = 1) {
  if (bad(n)) return NA;
  return `${(n * 100).toFixed(dp)}%`;
}

/** Already-percent value: 6.85 -> 6.85% */
export function pctRaw(n, dp = 2) {
  if (bad(n)) return NA;
  return `${n.toFixed(dp)}%`;
}

export function mult(n, dp = 2) {
  if (bad(n)) return NA;
  return `${n.toFixed(dp)}×`;
}

export function bps(n, signed = false) {
  if (bad(n)) return NA;
  const s = signed && n > 0 ? '+' : '';
  return `${s}${Math.round(n)} bps`;
}

/** Accounting negative: (1,240) */
export function acct(n, dp = 0) {
  if (bad(n)) return NA;
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return n < 0 ? `(${v})` : v;
}

export function signClass(n, invert = false) {
  if (bad(n) || n === 0) return '';
  const good = invert ? n < 0 : n > 0;
  return good ? 'pos' : 'neg';
}

export function monthLabel(index, startYear = 2026, startMonth = 0) {
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const t = startMonth + index;
  return `${m[((t % 12) + 12) % 12]} ${String((startYear + Math.floor(t / 12)) % 100).padStart(2, '0')}`;
}
