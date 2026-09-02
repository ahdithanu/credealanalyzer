import { FactStore } from '../temporal';

const SRC = 'hcad:2025';

describe('FactStore — validation', () => {
  it('requires a subject, predicate, validFrom and source', () => {
    const s = new FactStore();
    expect(() => s.assert({ predicate: 'p', value: 1, validFrom: '2025-01-01', source: SRC })).toThrow(/subject/);
    expect(() => s.assert({ subject: 'a', value: 1, validFrom: '2025-01-01', source: SRC })).toThrow(/predicate/);
    expect(() => s.assert({ subject: 'a', predicate: 'p', value: 1, source: SRC })).toThrow(/validFrom/);
    // Lineage is mandatory: a fact with no source cannot be defended in a memo.
    expect(() => s.assert({ subject: 'a', predicate: 'p', value: 1, validFrom: '2025-01-01' })).toThrow(/source/);
  });

  it('rejects a valid window that ends before it begins', () => {
    const s = new FactStore();
    expect(() => s.assert({
      subject: 'a', predicate: 'p', value: 1,
      validFrom: '2025-06-01', validTo: '2025-01-01', source: SRC,
    })).toThrow(/validTo/);
  });
});

describe('FactStore — valid time', () => {
  const s = new FactStore();
  s.assert({ subject: 'parcel:1', predicate: 'taxRate', value: 2.75, validFrom: '2024-01-01', validTo: '2025-01-01', recordedAt: '2024-02-01', source: SRC });
  s.assert({ subject: 'parcel:1', predicate: 'taxRate', value: 2.81, validFrom: '2025-01-01', validTo: '2026-01-01', recordedAt: '2025-02-01', source: SRC });

  it('returns the fact valid at the asked-for moment', () => {
    expect(s.value('parcel:1', 'taxRate', { validAt: '2024-06-01', knownAt: '2026-01-01' })).toBe(2.75);
    expect(s.value('parcel:1', 'taxRate', { validAt: '2025-06-01', knownAt: '2026-01-01' })).toBe(2.81);
  });

  it('treats validFrom as inclusive and validTo as exclusive', () => {
    expect(s.value('parcel:1', 'taxRate', { validAt: '2025-01-01', knownAt: '2026-01-01' })).toBe(2.81);
    expect(s.value('parcel:1', 'taxRate', { validAt: '2024-12-31', knownAt: '2026-01-01' })).toBe(2.75);
  });

  it('returns null outside every valid window', () => {
    expect(s.get('parcel:1', 'taxRate', { validAt: '2020-01-01', knownAt: '2026-01-01' })).toBeNull();
    expect(s.get('parcel:1', 'taxRate', { validAt: '2030-01-01', knownAt: '2030-01-01' })).toBeNull();
  });

  it('keeps an open-ended fact valid indefinitely', () => {
    const o = new FactStore();
    o.assert({ subject: 'x', predicate: 'p', value: 'v', validFrom: '2020-01-01', source: SRC, recordedAt: '2020-01-01' });
    expect(o.value('x', 'p', { validAt: '2099-01-01', knownAt: '2099-01-01' })).toBe('v');
  });
});

describe('FactStore — transaction time', () => {
  // The 2025 roll said 2.81%. In March 2026 the assessor corrected it to 2.68%,
  // retroactive to the same 2025 period.
  const s = new FactStore();
  s.assert({ subject: 'parcel:1', predicate: 'taxRate', value: 2.81, validFrom: '2025-01-01', validTo: '2026-01-01', recordedAt: '2025-02-01T00:00:00.000Z', source: 'hcad:2025' });
  s.assert({ subject: 'parcel:1', predicate: 'taxRate', value: 2.68, validFrom: '2025-01-01', validTo: '2026-01-01', recordedAt: '2026-03-03T00:00:00.000Z', source: 'hcad:2025-corrected' });

  it('reproduces what was known at a past moment', () => {
    // This is the audit question: what did the model see when IC approved?
    expect(s.value('parcel:1', 'taxRate', { validAt: '2025-06-01', knownAt: '2025-12-01' })).toBe(2.81);
  });

  it('returns current best knowledge by default', () => {
    expect(s.value('parcel:1', 'taxRate', { validAt: '2025-06-01' })).toBe(2.68);
  });

  it('never mutates or drops the superseded fact', () => {
    expect(s.size).toBe(2);
    const hist = s.history('parcel:1', 'taxRate');
    expect(hist).toHaveLength(2);
    expect(hist[0].value).toBe(2.68);       // newest knowledge first
    expect(hist[1].value).toBe(2.81);
  });

  it('identifies the retroactive correction', () => {
    const c = s.corrections('2026-01-01');
    expect(c).toHaveLength(1);
    expect(c[0].from.value).toBe(2.81);
    expect(c[0].to.value).toBe(2.68);
    expect(c[0].predicate).toBe('taxRate');
  });

  it('does not report a new fact over an untouched period as a correction', () => {
    const t = new FactStore();
    t.assert({ subject: 'a', predicate: 'p', value: 1, validFrom: '2024-01-01', validTo: '2025-01-01', recordedAt: '2024-01-01', source: SRC });
    t.assert({ subject: 'a', predicate: 'p', value: 2, validFrom: '2025-01-01', validTo: '2026-01-01', recordedAt: '2025-01-01', source: SRC });
    expect(t.corrections('2023-01-01')).toEqual([]);
  });
});

describe('FactStore — snapshot and serialisation', () => {
  const s = new FactStore();
  s.assert({ subject: 'metro:houston', predicate: 'population', value: 7_340_000, validFrom: '2023-01-01', recordedAt: '2024-09-01', source: 'census:acs5:2023' });
  s.assert({ subject: 'metro:houston', predicate: 'medianHHI', value: 72_000, validFrom: '2023-01-01', recordedAt: '2024-09-01', source: 'census:acs5:2023' });

  it('snapshots every predicate at both clocks', () => {
    const snap = s.snapshot('metro:houston', { validAt: '2024-01-01', knownAt: '2025-01-01' });
    expect(Object.keys(snap).sort()).toEqual(['medianHHI', 'population']);
    expect(snap.population.value).toBe(7_340_000);
    expect(snap.population.source).toBe('census:acs5:2023');
  });

  it('omits predicates not yet known at the given moment', () => {
    expect(s.snapshot('metro:houston', { validAt: '2024-01-01', knownAt: '2024-01-01' })).toEqual({});
  });

  it('round-trips through JSON without losing lineage', () => {
    const back = FactStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(back.size).toBe(s.size);
    expect(back.value('metro:houston', 'population', { validAt: '2024-01-01', knownAt: '2025-01-01' })).toBe(7_340_000);
  });
});

describe('FactStore.get — ties on the transaction clock', () => {
  // canonicalize() stamps one recordedAt across a whole ingest batch, so an
  // open-ended fact and a bounded one from the same source tie by construction.
  // Resolved by array order the answer depended on the order facts happened to
  // sit in — which then made fact ORDER load-bearing for the persistence layer,
  // for a reason nothing on screen could explain.
  const BATCH = '2026-01-15T00:00:00.000Z';
  const AT = { validAt: '2026-03-01', knownAt: '2026-06-01' };

  const bounded = {
    subject: 'parcel:a', predicate: 'taxRate', value: 2.68,
    validFrom: '2026-01-01', validTo: '2027-01-01', recordedAt: BATCH, source: 'hcad:2026',
  };
  const openEnded = {
    subject: 'parcel:a', predicate: 'taxRate', value: 2.81,
    validFrom: '2026-01-01', recordedAt: BATCH, source: 'hcad:standing',
  };

  it('prefers the narrower valid window, whichever order the facts arrived in', () => {
    const boundedFirst = new FactStore();
    boundedFirst.assertMany([bounded, openEnded]);
    const openFirst = new FactStore();
    openFirst.assertMany([openEnded, bounded]);

    expect(boundedFirst.value('parcel:a', 'taxRate', AT)).toBe(2.68);
    expect(openFirst.value('parcel:a', 'taxRate', AT)).toBe(2.68);
  });

  it('still lets later knowledge beat a narrower window', () => {
    // The tie-break only breaks TIES. A correction recorded afterwards wins
    // however wide its window, or the audit trail would run backwards.
    const s = new FactStore();
    s.assertMany([bounded, {
      ...openEnded, value: 2.55, recordedAt: '2026-04-01T00:00:00.000Z',
    }]);
    expect(s.value('parcel:a', 'taxRate', AT)).toBe(2.55);
  });
});

