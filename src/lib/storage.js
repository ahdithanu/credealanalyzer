/**
 * Local persistence.
 *
 * The application previously advertised local persistence but implemented none:
 * a mount-time effect overwrote state with hardcoded sample deals on every
 * page load, so any deal a user entered was lost on refresh.
 *
 * This is still browser-local and therefore single-user, per-device, and
 * cleared with site data. It is a stopgap, not the enterprise answer — that is
 * a server with tenancy, roles, and an audit trail. Treated as a cache of
 * record here, and the UI should say so.
 */

const STORAGE_KEY = 'cre-deal-analyzer:deals';
const SCHEMA_VERSION = 2;

function storage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    // Probe: Safari private mode throws on setItem rather than on access.
    const probe = '__cre_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when deals can actually be persisted in this browser context. */
export function isPersistenceAvailable() {
  return storage() !== null;
}

/**
 * Load saved deals.
 * @returns {{deals:Array|null, error:string|null, migrated:boolean}}
 *          `deals: null` means nothing has ever been saved — the caller should
 *          seed samples. An empty array means the user deleted everything and
 *          must NOT be re-seeded.
 */
export function loadDeals() {
  const store = storage();
  if (!store) return { deals: null, error: 'unavailable', migrated: false };

  let raw;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { deals: null, error: 'unavailable', migrated: false };
  }
  if (raw === null) return { deals: null, error: null, migrated: false };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt payload. Preserve it for support rather than destroying it.
    try { store.setItem(STORAGE_KEY + ':corrupt:' + Date.now(), raw); } catch { /* best effort */ }
    return { deals: null, error: 'corrupt', migrated: false };
  }

  const { deals, migrated } = migrate(parsed);
  return { deals, error: null, migrated };
}

/**
 * Persist deals. Metrics are stripped before writing: they are derived, and
 * storing them means a stale cached number survives an engine correction.
 * @returns {{ok:boolean, error:string|null}}
 */
export function saveDeals(deals) {
  const store = storage();
  if (!store) return { ok: false, error: 'unavailable' };
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    deals: (deals || []).map(stripDerived),
  };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(payload));
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e && e.name === 'QuotaExceededError' ? 'quota' : 'write-failed' };
  }
}

export function clearDeals() {
  const store = storage();
  if (!store) return false;
  try { store.removeItem(STORAGE_KEY); return true; } catch { return false; }
}

/** Derived values are recomputed on load, never trusted from disk. */
function stripDerived(deal) {
  const { metrics, model, ...rest } = deal || {};
  return rest;
}

/**
 * Bring a stored payload up to the current schema.
 *
 * v1: a bare array of deals, with cached `metrics` from the old engine.
 * v2: an envelope with a schema version; metrics always recomputed.
 */
function migrate(parsed) {
  if (Array.isArray(parsed)) {
    return { deals: parsed.map(stripDerived).filter(isPlausibleDeal), migrated: true };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.deals)) {
    return {
      deals: parsed.deals.map(stripDerived).filter(isPlausibleDeal),
      migrated: parsed.schemaVersion !== SCHEMA_VERSION,
    };
  }
  return { deals: null, migrated: false };
}

function isPlausibleDeal(d) {
  return Boolean(d) && typeof d === 'object' && (typeof d.id === 'number' || typeof d.id === 'string');
}

export const __internals = { STORAGE_KEY, SCHEMA_VERSION };
