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

const UNAVAILABLE = 'unavailable';
const QUOTA = 'quota';
const PROBE_KEY = '__cre_probe__';

/**
 * The store itself, if this context has one AT ALL.
 *
 * Deliberately does NOT write: a browser whose quota is exhausted still reads
 * back everything the user has saved, and a probe that writes first reported
 * the whole facility missing and handed the caller `deals: null` — which App
 * reads as "nothing has ever been saved" and answers by seeding the sample
 * portfolio OVER the user's deals. Reading and writing are different questions
 * and are now asked separately.
 */
function storage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Access itself throws where the API is disabled by policy.
    return null;
  }
}

/**
 * Whether an exception is the browser saying "no room", rather than any other
 * write failure.
 *
 * Browsers disagree on how they signal this and the MESSAGE is the one field
 * that is pure prose — Chrome, Firefox and Safari each word it differently and
 * localise it — so the name and the legacy numeric code are what is tested.
 * Matching on message text is how a full disk gets reported as a generic
 * write failure in every locale but English.
 */
function isQuotaError(e) {
  if (!e) return false;
  return e.name === 'QuotaExceededError'          // current DOM standard
    || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'    // Firefox, legacy name
    || e.name === 'QUOTA_EXCEEDED_ERR'            // older WebKit
    || e.code === 22                              // DOMException.QUOTA_EXCEEDED_ERR
    || e.code === 1014;                           // Firefox, legacy code
}

/** Whether the origin holds anything at all. See quotaOrAbsent(). */
function hasStoredContent(store) {
  try { return store.length > 0; } catch { return false; }
}

/**
 * A quota exception means two opposite things depending on what is already
 * stored, and the user needs a different action for each.
 *
 * A store that already holds keys and refuses one more is FULL: the fix is to
 * delete some deals. A store that is empty and still refuses the first byte was
 * never given any quota — Safari private browsing is the common case — and the
 * fix is to leave private browsing or export instead. Reporting the second as
 * "storage is full" tells a user to delete data that does not exist.
 */
function quotaOrAbsent(store) {
  return hasStoredContent(store) ? QUOTA : UNAVAILABLE;
}

/**
 * What this browser will actually let us do.
 * @returns {'available'|'quota'|'unavailable'}
 *   'quota' means reads work and writes do not, which is a state the previous
 *   probe could not express at all: it round-tripped a setItem and reported a
 *   full quota as an absent API, leaving App's "Browser storage is full" notice
 *   unreachable and its "storage is unavailable" notice telling a user with a
 *   full disk to check their private-browsing setting.
 */
export function storageStatus() {
  const store = storage();
  if (!store) return UNAVAILABLE;
  try {
    store.setItem(PROBE_KEY, '1');
    store.removeItem(PROBE_KEY);
    return 'available';
  } catch (e) {
    return isQuotaError(e) ? quotaOrAbsent(store) : UNAVAILABLE;
  }
}

/**
 * True when deals can actually be persisted in this browser context.
 *
 * A full quota is NOT this: reads still work, so the caller must not treat it
 * as an absent facility. storageStatus() is what tells the three states apart.
 */
export function isPersistenceAvailable() {
  return storageStatus() === 'available';
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
  if (!store) return { deals: null, error: UNAVAILABLE, migrated: false };

  const status = storageStatus();
  if (status === UNAVAILABLE) return { deals: null, error: UNAVAILABLE, migrated: false };
  // A full quota does not stop a read, so the deals still come back; the error
  // rides alongside them. Returning `deals: null` here is what made App reseed
  // the sample portfolio over a full-disk user's own work.
  const quota = status === QUOTA ? QUOTA : null;

  let raw;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { deals: null, error: UNAVAILABLE, migrated: false };
  }
  if (raw === null) return { deals: null, error: quota, migrated: false };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt payload. Preserve it for support rather than destroying it.
    try { store.setItem(STORAGE_KEY + ':corrupt:' + Date.now(), raw); } catch { /* best effort */ }
    return { deals: null, error: 'corrupt', migrated: false };
  }

  const { deals, migrated } = migrate(parsed);
  return { deals, error: quota, migrated };
}

/**
 * Persist deals. Metrics are stripped before writing: they are derived, and
 * storing them means a stale cached number survives an engine correction.
 * @returns {{ok:boolean, error:string|null}}
 */
export function saveDeals(deals) {
  const store = storage();
  if (!store) return { ok: false, error: UNAVAILABLE };
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    deals: (deals || []).map((d) => withWaterfall(stripDerived(d))),
  };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(payload));
    return { ok: true, error: null };
  } catch (e) {
    // The write path is the one that matters: a QuotaExceededError here is the
    // common way a user meets a full disk, and it used to be unreachable —
    // the availability probe wrote first, failed first, and every caller was
    // told the facility was missing before saveDeals() was ever reached.
    //
    // Only the standard error NAME was tested, so Firefox's legacy name and the
    // numeric codes fell through to 'write-failed', which App renders as a
    // generic failure with no instruction. isQuotaError() reads name and code.
    if (!isQuotaError(e)) return { ok: false, error: 'write-failed' };
    return { ok: false, error: quotaOrAbsent(store) };
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
