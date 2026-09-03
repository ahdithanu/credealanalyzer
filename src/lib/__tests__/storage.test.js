import { loadDeals, saveDeals, clearDeals, isPersistenceAvailable, storageStatus, __internals } from '../storage';

const { STORAGE_KEY, SCHEMA_VERSION } = __internals;

beforeEach(() => window.localStorage.clear());

const deal = (id, name) => ({ id, name, propertyType: 'carwash', purchasePrice: 100 });

describe('storage', () => {
  it('reports availability in a browser context', () => {
    expect(isPersistenceAvailable()).toBe(true);
  });

  it('round-trips deals', () => {
    saveDeals([deal(1, 'A'), deal(2, 'B')]);
    const { deals, error } = loadDeals();
    expect(error).toBeNull();
    expect(deals.map((d) => d.name)).toEqual(['A', 'B']);
  });

  it('distinguishes "never saved" from "saved empty"', () => {
    // This is the bug that made the original app re-seed samples over user data.
    expect(loadDeals().deals).toBeNull();
    saveDeals([]);
    expect(loadDeals().deals).toEqual([]);
  });

  it('strips derived metrics so a stale number cannot survive an engine fix', () => {
    saveDeals([{ ...deal(1, 'A'), metrics: { noi: 999 }, model: { months: [] } }]);
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    expect(raw.deals[0].metrics).toBeUndefined();
    expect(raw.deals[0].model).toBeUndefined();
  });

  it('writes a schema version and timestamp', () => {
    saveDeals([deal(1, 'A')]);
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Date.parse(raw.savedAt)).not.toBeNaN();
  });

  it('migrates a bare v1 array and drops its cached metrics', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...deal(1, 'Legacy'), metrics: { noi: 1 } }]));
    const { deals, migrated } = loadDeals();
    expect(migrated).toBe(true);
    expect(deals[0].name).toBe('Legacy');
    expect(deals[0].metrics).toBeUndefined();
  });

  it('quarantines a corrupt payload instead of discarding it', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    const { deals, error } = loadDeals();
    expect(error).toBe('corrupt');
    expect(deals).toBeNull();
    const quarantined = Object.keys(window.localStorage).filter((k) => k.startsWith(STORAGE_KEY + ':corrupt:'));
    expect(quarantined).toHaveLength(1);
  });

  it('drops entries that are not plausible deals', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([deal(1, 'A'), null, 'nonsense', {}]));
    expect(loadDeals().deals).toHaveLength(1);
  });

  it('clears saved deals', () => {
    saveDeals([deal(1, 'A')]);
    clearDeals();
    expect(loadDeals().deals).toBeNull();
  });

  it('reports a failure rather than throwing when writes are blocked', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('disk on fire');
    });
    // Not a quota signal, so it is not reported as one.
    expect(saveDeals([deal(1, 'A')])).toEqual({ ok: false, error: 'write-failed' });
    spy.mockRestore();
  });
});

/**
 * POLICY CHANGE — a full quota is no longer indistinguishable from an absent
 * localStorage.
 *
 * The old availability probe round-tripped a setItem, so a browser whose quota
 * was exhausted failed the probe and the module answered 'unavailable' on every
 * path. Two consequences, both asserted below:
 *
 *  1. saveDeals() never returned 'quota'. The previous version of the write test
 *     asserted exactly that — a QuotaExceededError thrown from setItem came back
 *     as `{ok: false, error: 'unavailable'}` — which made App's "Browser storage
 *     is full" notice dead code and told a user with a full disk to check their
 *     private-browsing setting instead of deleting deals. That test is not
 *     deleted; it is retained above, narrowed to what it can still honestly
 *     assert (a NON-quota write failure), and the quota cases are stated here.
 *
 *  2. loadDeals() returned `deals: null` on a full quota, which App reads as
 *     "nothing has ever been saved" and answers by seeding the sample portfolio
 *     over the user's own deals. Reads do not consume quota, so they now succeed
 *     and the error rides alongside the deals.
 *
 * The two states need different things from the user — leave private browsing
 * versus delete some deals — so they are different values.
 */
describe('a full quota is distinguishable from an absent localStorage', () => {
  const quotaError = ({ name, code }) => {
    const e = new Error('irrelevant prose the browser localises');
    if (name !== undefined) e.name = name;
    if (code !== undefined) e.code = code;
    return e;
  };

  /** Throw on the real payload write, but let anything already stored stay. */
  const blockWrites = (error) =>
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw error; });

  // Every signal a browser in the wild actually uses. The MESSAGE is never one
  // of them: it is prose, it differs per engine, and it is localised.
  const SIGNALS = [
    ['the DOM standard name', { name: 'QuotaExceededError' }],
    ['the Firefox legacy name', { name: 'NS_ERROR_DOM_QUOTA_REACHED' }],
    ['the older WebKit name', { name: 'QUOTA_EXCEEDED_ERR' }],
    ['the DOMException code', { name: 'Error', code: 22 }],
    ['the Firefox legacy code', { name: 'Error', code: 1014 }],
  ];

  it.each(SIGNALS)('reports a full store as quota, however the browser signals it (%s)', (_label, shape) => {
    // Something is already stored, so the store HAS quota and has run out of it.
    saveDeals([deal(1, 'A')]);
    const spy = blockWrites(quotaError(shape));
    expect(saveDeals([deal(1, 'A'), deal(2, 'B')])).toEqual({ ok: false, error: 'quota' });
    expect(storageStatus()).toBe('quota');
    spy.mockRestore();
  });

  it('still reads the saved deals back when the store is full', () => {
    // The whole point of separating the two: a full disk must not look like a
    // first visit, or App reseeds the sample portfolio over the user's work.
    saveDeals([deal(1, 'A'), deal(2, 'B')]);
    const spy = blockWrites(quotaError({ name: 'QuotaExceededError' }));
    const { deals, error } = loadDeals();
    expect(deals.map((d) => d.name)).toEqual(['A', 'B']);
    expect(error).toBe('quota');
    spy.mockRestore();
  });

  it('reports an empty store that refuses its first byte as unavailable, not full', () => {
    // Safari private browsing: the API is present and throws a quota error with
    // nothing stored at all. "Browser storage is full — delete some deals" would
    // be advice about data that does not exist.
    const spy = blockWrites(quotaError({ name: 'QuotaExceededError' }));
    expect(storageStatus()).toBe('unavailable');
    expect(saveDeals([deal(1, 'A')])).toEqual({ ok: false, error: 'unavailable' });
    expect(isPersistenceAvailable()).toBe(false);
    spy.mockRestore();
  });

  it('does not read the exception message to decide', () => {
    saveDeals([deal(1, 'A')]);
    // A generic failure whose prose happens to mention the word.
    const e = new Error('QuotaExceededError: the disk is full');
    e.name = 'TypeError';
    const spy = blockWrites(e);
    expect(saveDeals([deal(1, 'A')]).error).toBe('write-failed');
    spy.mockRestore();
  });

  it('separates the three states', () => {
    expect(storageStatus()).toBe('available');
    expect(isPersistenceAvailable()).toBe(true);
  });
});

/**
 * The promote structure used to live in the Waterfall screen's component state
 * and was never written to the deal, so it died on every reload and the memo
 * and that screen could describe two different promotes for one deal.
 */
describe('promote structure', () => {
  const structure = {
    prefRate: 0.09,
    prefCompounding: false,
    catchUp: { enabled: true, gpShare: 0.5, targetPromoteShare: null },
    tiers: [{ irrHurdle: 0.15, gpShare: 0.2 }, { irrHurdle: null, gpShare: 0.3 }],
  };
  // Not open-ended at the top: resolveWaterfall() refuses it because the money
  // above the last hurdle has no split. It is a state an analyst passes through
  // while typing a tier stack, so it can reach disk.
  const unrunnable = { tiers: [{ irrHurdle: 0.15, gpShare: 0.2 }] };

  it('round-trips the structure the analyst configured', () => {
    saveDeals([{ ...deal(1, 'A'), waterfall: structure }]);
    expect(loadDeals().deals[0].waterfall).toEqual(structure);
  });

  it('records the absence of a structure rather than omitting the field', () => {
    // A missing key and a null are the same fact, but only one of them states
    // it. Downstream code reading a bare `deal.waterfall` cannot tell "this
    // deal has no promote" from "this field was lost", and the difference
    // decides whether the memo's returns are labelled pre-promote.
    saveDeals([deal(1, 'A')]);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)).deals[0];
    expect('waterfall' in stored).toBe(true);
    expect(stored.waterfall).toBeNull();
    expect(loadDeals().deals[0].waterfall).toBeNull();
  });

  it('loads a deal saved before promote structures were persisted', () => {
    // The v2 envelope has no waterfall key anywhere. It must still load, and
    // it must load pre-promote — not with a default promote invented for it.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: 2,
      savedAt: '2026-01-01T00:00:00.000Z',
      deals: [{ id: 7, name: 'Legacy', purchasePrice: 4200000, holdPeriod: 5 }],
    }));
    const { deals, migrated } = loadDeals();
    expect(migrated).toBe(true);
    expect(deals[0].name).toBe('Legacy');
    expect(deals[0].purchasePrice).toBe(4200000);
    expect(deals[0].waterfall).toBeNull();
  });

  it('migrates a bare v1 array to an explicit absence too', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([deal(1, 'Ancient')]));
    expect(loadDeals().deals[0].waterfall).toBeNull();
  });

  it('hands back a structure the engine refuses, byte for byte, rather than repairing it', () => {
    // A half-typed tier stack is the analyst's work in progress. Dropping it
    // would destroy it; silently completing it would put a fabricated promote
    // in front of a committee. It survives the round trip untouched.
    //
    // POLICY: this module no longer decides whether a stored structure splits
    // anything, and loadDeals() no longer returns `rejectedWaterfalls`. That
    // verdict is a fact about a structure AND a model — a structure can be
    // perfectly valid with no equity schedule under it, and the co-invest the
    // split runs on comes off the model's capital stack rather than off the
    // stored object — so a verdict reached from the stored bytes alone
    // disagreed with the memo, the CSV and the Waterfall screen in both
    // directions. promoteState() in waterfall.js is the single predicate, and
    // its four states are asserted in waterfall.test.js.
    saveDeals([{ ...deal(1, 'Half-typed'), waterfall: unrunnable }]);
    const { deals } = loadDeals();
    expect(deals[0].waterfall).toEqual(unrunnable);
    expect(loadDeals()).not.toHaveProperty('rejectedWaterfalls');
  });

  it('drops a stored value that is not a structure at all', () => {
    // Nothing this app writes produces a string or an array here, so there is
    // nothing to repair and no analyst input to preserve. A structure whose
    // ARITHMETIC has no answer is the opposite case and is kept above.
    for (const junk of ['{"prefRate":0.08}', 42, [], true]) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schemaVersion: __internals.SCHEMA_VERSION,
        deals: [{ ...deal(1, 'A'), waterfall: junk }],
      }));
      expect(loadDeals().deals[0].waterfall).toBeNull();
    }
  });

  it('reports a payload at an older schema version as migrated', () => {
    // The version is what tells a reader the shape on disk changed. Writing the
    // new shape under the old number would make the migration undetectable.
    expect(SCHEMA_VERSION).toBeGreaterThan(2);
    saveDeals([deal(1, 'A')]);
    expect(loadDeals().migrated).toBe(false);
    const payload = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...payload, schemaVersion: 2 }));
    expect(loadDeals().migrated).toBe(true);
  });
});
