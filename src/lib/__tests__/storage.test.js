import { loadDeals, saveDeals, clearDeals, isPersistenceAvailable, __internals } from '../storage';

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
      const e = new Error('full'); e.name = 'QuotaExceededError'; throw e;
    });
    expect(saveDeals([deal(1, 'A')])).toEqual({ ok: false, error: 'unavailable' });
    spy.mockRestore();
  });
});
