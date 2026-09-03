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
const SCHEMA_VERSION = 3;

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
 *
 * A stored promote structure is handed back exactly as it was saved, including
 * one whose arithmetic has no answer: it is the analyst's half-typed work and
 * deleting it would destroy it. This module deliberately does NOT adjudicate
 * whether a structure splits anything. That is a fact about a structure AND a
 * model — a structure can also be perfectly valid with no equity schedule under
 * it, and the co-invest the split actually runs on comes off the model's
 * capital stack, not off the stored object — so a verdict reached here from the
 * stored bytes alone disagreed with the memo, the CSV and the Waterfall screen
 * in both directions. `promoteState()` in waterfall.js is the one predicate;
 * App runs it over the live deals.
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
    deals: (deals || []).map((d) => withWaterfall(stripDerived(d))),
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
 * The promote structure, stated rather than omitted.
 *
 * A missing key and a null are the same fact — this deal has no promote
 * structure, so its returns are project-level — but only one of them says it.
 * v2 deals omit the key, and code downstream of a bare `deal.waterfall` read
 * cannot tell "no structure" from "field lost in a partial write". Writing the
 * null makes the absence a recorded decision that survives the round trip.
 *
 * Anything that is not an object is not a structure any version of this app
 * ever wrote, so it cannot be repaired into one and is dropped to null. A
 * structure whose ARITHMETIC has no answer is a different matter and is kept
 * verbatim — see the note on loadDeals(); promoteState() in waterfall.js is
 * what decides whether it splits anything.
 */
function withWaterfall(deal) {
  const wf = deal.waterfall;
  const usable = Boolean(wf) && typeof wf === 'object' && !Array.isArray(wf);
  return { ...deal, waterfall: usable ? wf : null };
}

/**
 * Bring a stored payload up to the current schema.
 *
 * v1: a bare array of deals, with cached `metrics` from the old engine.
 * v2: an envelope with a schema version; metrics always recomputed.
 * v3: every deal states its promote structure, `waterfall: null` where it has
 *     none. Before v3 the structure lived in component state and was never
 *     written at all, so a v1 or v2 deal migrates to an explicit null and
 *     keeps the pre-promote returns it was saved with.
 */
function migrate(parsed) {
  if (Array.isArray(parsed)) {
    return { deals: parsed.map(stripDerived).filter(isPlausibleDeal).map(withWaterfall), migrated: true };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.deals)) {
    return {
      deals: parsed.deals.map(stripDerived).filter(isPlausibleDeal).map(withWaterfall),
      migrated: parsed.schemaVersion !== SCHEMA_VERSION,
    };
  }
  return { deals: null, migrated: false };
}

function isPlausibleDeal(d) {
  return Boolean(d) && typeof d === 'object' && (typeof d.id === 'number' || typeof d.id === 'string');
}

export const __internals = { STORAGE_KEY, SCHEMA_VERSION };
