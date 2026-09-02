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


describe('FactStore — clocks are instants, not text', () => {
  // ISO-8601 does not require zero padding. '2025-1-1' is a legal date that
  // sorts AFTER '2025-06-01' as a string, so a text comparison answered a
  // question about June with null — indistinguishable from "we never knew".
  const unpadded = {
    subject: 'parcel:1', predicate: 'taxRate', value: 2.75,
    validFrom: '2025-1-1', validTo: '2026-1-1', recordedAt: '2025-2-1', source: SRC,
  };

  it('sees a fact whose validFrom is not zero-padded', () => {
    const s = new FactStore();
    s.assert(unpadded);
    expect(s.value('parcel:1', 'taxRate', { validAt: '2025-06-01', knownAt: '2026-01-01' })).toBe(2.75);
  });

  it('sees a fact whose recordedAt is not zero-padded', () => {
    const s = new FactStore();
    s.assert(unpadded);
    // Recorded in February, asked in October: known by then on any clock that
    // is a clock. As text, '2025-2-1' > '2025-10-01'.
    expect(s.value('parcel:1', 'taxRate', { validAt: '2025-06-01', knownAt: '2025-10-01' })).toBe(2.75);
  });

  it('expires a fact at an unpadded validTo instead of running past it', () => {
    // The dangerous direction: the window closed on 1 January 2025 and a text
    // compare kept answering with it all through 2025.
    const s = new FactStore();
    s.assert({
      subject: 'parcel:1', predicate: 'taxRate', value: 2.75,
      validFrom: '2024-01-01', validTo: '2025-1-1', recordedAt: '2024-02-01', source: SRC,
    });
    expect(s.get('parcel:1', 'taxRate', { validAt: '2025-06-01', knownAt: '2026-01-01' })).toBeNull();
    expect(s.value('parcel:1', 'taxRate', { validAt: '2024-06-01', knownAt: '2026-01-01' })).toBe(2.75);
  });

  it('rejects an unpadded window that ends before it begins', () => {
    const s = new FactStore();
    expect(() => s.assert({
      subject: 'a', predicate: 'p', value: 1,
      validFrom: '2025-06-01', validTo: '2025-1-1', source: SRC, recordedAt: '2025-01-01',
    })).toThrow(/validTo/);
  });

  it('refuses a timestamp that names no instant rather than storing it off-clock', () => {
    const s = new FactStore();
    expect(() => s.assert({ subject: 'a', predicate: 'p', value: 1, validFrom: 'last Tuesday', source: SRC }))
      .toThrow(/validFrom/);
    expect(() => s.assert({ subject: 'a', predicate: 'p', value: 1, validFrom: '2025-01-01', recordedAt: 'soon', source: SRC }))
      .toThrow(/recordedAt/);
    expect(s.size).toBe(0);
  });

  it('refuses a query moment that names no instant rather than answering it', () => {
    // A wrong number in front of a committee is worse than no number: nothing
    // downstream can tell this answer from a real one.
    const s = new FactStore();
    s.assert({ subject: 'a', predicate: 'p', value: 1, validFrom: '2025-01-01', recordedAt: '2025-01-01', source: SRC });
    expect(() => s.get('a', 'p', { validAt: 'whenever', knownAt: '2026-01-01' })).toThrow(/validAt/);
    expect(() => s.get('a', 'p', { validAt: '2025-06-01', knownAt: 'whenever' })).toThrow(/knownAt/);
  });

  it('orders history by the transaction clock, not by text', () => {
    const s = new FactStore();
    s.assert({ subject: 'a', predicate: 'p', value: 'march', validFrom: '2026-01-01', recordedAt: '2026-3-3', source: SRC });
    s.assert({ subject: 'a', predicate: 'p', value: 'october', validFrom: '2026-01-01', recordedAt: '2026-10-01', source: SRC });
    // Newest knowledge first. As text, '2026-3-3' > '2026-10-01'.
    expect(s.history('a', 'p').map((f) => f.value)).toEqual(['october', 'march']);
  });
});

describe('FactStore.fromJSON — a payload is not trusted', () => {
  const good = {
    subject: 'parcel:1', predicate: 'taxRate', value: 2.68,
    validFrom: '2025-01-01', validTo: '2026-01-01',
    recordedAt: '2026-03-03T00:00:00.000Z', source: 'hcad:2025-corrected',
  };
  const noRecordedAt = {
    subject: 'parcel:1', predicate: 'taxRate', value: 2.81,
    validFrom: '2025-01-01', validTo: '2026-01-01', source: 'hcad:2025',
  };

  it('never lets a fact off the transaction clock outrank one on it', () => {
    // The named failure mode: undefined loses every comparison, so such a fact
    // slipped past the knownAt filter AND could never be superseded. A fact
    // that cannot be corrected is the worst failure in an append-only store.
    const s = FactStore.fromJSON({ facts: [noRecordedAt, good] });
    expect(s.value('parcel:1', 'taxRate', { validAt: '2025-06-01', knownAt: '2026-06-01' })).toBe(2.68);
    // And it is not returned by pinning the transaction clock either.
    expect(s.get('parcel:1', 'taxRate', { validAt: '2025-06-01', knownAt: '2025-06-01' })).toBeNull();
  });

  it('quarantines the malformed row where the caller can see it', () => {
    const s = FactStore.fromJSON({ facts: [noRecordedAt, good] });
    expect(s.size).toBe(1);
    expect(s.quarantined).toHaveLength(1);
    expect(s.quarantined[0].index).toBe(0);
    expect(s.quarantined[0].reason).toMatch(/recordedAt/);
    // Kept verbatim: quarantine sets a row aside, it does not edit or lose it.
    expect(s.quarantined[0].fact).toEqual(noRecordedAt);
  });

  it('names every way a row fails to reach both clocks', () => {
    const s = FactStore.fromJSON({
      facts: [
        null,
        { predicate: 'p', validFrom: '2025-01-01', recordedAt: '2025-01-01', source: SRC },
        { subject: 'a', predicate: 'p', validFrom: '2025-01-01', recordedAt: '2025-01-01' },
        { subject: 'a', predicate: 'p', validFrom: 'sometime', recordedAt: '2025-01-01', source: SRC },
        { subject: 'a', predicate: 'p', validFrom: '2025-01-01', validTo: 'later', recordedAt: '2025-01-01', source: SRC },
        { subject: 'a', predicate: 'p', validFrom: '2025-06-01', validTo: '2025-1-1', recordedAt: '2025-01-01', source: SRC },
      ],
    });
    expect(s.size).toBe(0);
    expect(s.quarantined.map((q) => q.reason)).toEqual([
      'not an object',
      'missing subject',
      'missing source',
      'validFrom is not a timestamp that names an instant',
      'validTo is not a timestamp that names an instant',
      'validTo on or before validFrom',
    ]);
  });

  it('carries quarantined rows through serialisation rather than losing them', () => {
    // Re-saving a loaded store must not be how evidence disappears.
    const once = FactStore.fromJSON({ facts: [noRecordedAt, good] });
    const twice = FactStore.fromJSON(JSON.parse(JSON.stringify(once.toJSON())));
    expect(twice.size).toBe(1);
    expect(twice.quarantined).toHaveLength(1);
    expect(twice.quarantined[0].fact).toEqual(noRecordedAt);
  });

  it('leaves a clean store serialising exactly as it always did', () => {
    const s = new FactStore();
    s.assert(good);
    expect(Object.keys(s.toJSON())).toEqual(['facts']);
  });

  it('refuses a payload with no facts array instead of yielding an empty store', () => {
    // An empty store answers every question with null, which reads as "nothing
    // was ever recorded" — the one answer a corrupt payload must not produce.
    expect(() => FactStore.fromJSON(undefined)).toThrow(/facts array/);
    expect(() => FactStore.fromJSON({})).toThrow(/facts array/);
    expect(() => FactStore.fromJSON({ facts: 'nope' })).toThrow(/facts array/);
    expect(() => FactStore.fromJSON({ facts: [], quarantined: 'nope' })).toThrow(/quarantined/);
  });

  it('does not invent a confidence the payload never carried', () => {
    const s = FactStore.fromJSON({ facts: [good] });
    expect(s.get('parcel:1', 'taxRate', { validAt: '2025-06-01', knownAt: '2026-06-01' }).confidence).toBeNull();
  });
});

describe('FactStore.corrections — supersession inside one ingest batch', () => {
  // canonicalize() stamps ONE recordedAt across a whole batch, so a correction
  // arriving beside the fact it supersedes shares its millisecond. Looking back
  // at 'recordedAt - 1ms' for the prior value could never see it.
  const BATCH = '2026-01-15T00:00:00.000Z';
  const WINDOW = { validFrom: '2026-01-01', validTo: '2027-01-01' };
  const AT = { validAt: '2026-03-01', knownAt: '2026-06-01' };

  const sameBatch = () => {
    const s = new FactStore();
    s.assertMany([
      { subject: 'parcel:a', predicate: 'taxRate', value: 2.81, ...WINDOW, recordedAt: BATCH, source: 'hcad:2026' },
      { subject: 'parcel:a', predicate: 'taxRate', value: 2.68, ...WINDOW, recordedAt: BATCH, source: 'hcad:2026-corrected' },
    ]);
    return s;
  };

  it('reports a correction that shares its millisecond with the fact it supersedes', () => {
    const c = sameBatch().corrections('2026-01-01');
    expect(c).toHaveLength(1);
    expect(c[0].predicate).toBe('taxRate');
    expect(c[0].from.value).toBe(2.81);
    expect(c[0].to.value).toBe(2.68);
    expect(c[0].from.source).toBe('hcad:2026');
    expect(c[0].to.source).toBe('hcad:2026-corrected');
  });

  it('answers with the corrected value, not the one it superseded', () => {
    // Two claims about the same subject, predicate and window at the same
    // instant: the append log is the only record of which arrived second, and
    // preferring the first makes the correction unable ever to land.
    expect(sameBatch().value('parcel:a', 'taxRate', AT)).toBe(2.68);
  });

  it('does not report a same-batch fact that never becomes the answer', () => {
    // An open-ended fact appended after a bounded one loses the tie-break, so
    // the store's answer never changed and no correction occurred.
    const s = new FactStore();
    s.assertMany([
      { subject: 'parcel:a', predicate: 'taxRate', value: 2.68, ...WINDOW, recordedAt: BATCH, source: 'hcad:2026' },
      { subject: 'parcel:a', predicate: 'taxRate', value: 2.81, validFrom: '2026-01-01', recordedAt: BATCH, source: 'hcad:standing' },
    ]);
    expect(s.value('parcel:a', 'taxRate', AT)).toBe(2.68);
    expect(s.corrections('2026-01-01')).toEqual([]);
  });

  it('reports each step of a chain of corrections exactly once', () => {
    const s = sameBatch();
    s.assert({ subject: 'parcel:a', predicate: 'taxRate', value: 2.55, ...WINDOW, recordedAt: '2026-04-01T00:00:00.000Z', source: 'hcad:2026-r2' });
    expect(s.corrections('2026-01-01').map((c) => [c.from.value, c.to.value])).toEqual([[2.81, 2.68], [2.68, 2.55]]);
  });

  it('refuses a `since` that names no instant', () => {
    expect(() => sameBatch().corrections('recently')).toThrow(/since/);
  });
});

describe('FactStore — a timestamp names the same instant in every time zone', () => {
  // Jest runs in UTC, which is exactly why these defects survived: the split
  // below is invisible at UTC+00:00 and the app is a browser SPA running in the
  // user's zone.
  const asUtc = (text) => Date.UTC(
    Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, Number(text.slice(8, 10)),
  );

  it('places an unpadded date on the same instant as its padded form', () => {
    // ES2015+ sends a padded ISO date-only string to UTC and anything the ISO
    // grammar rejects — '2025-1-1', this module's own motivating example — to
    // the implementation parser, which uses LOCAL time. At UTC-05:00 that left
    // a five-hour hole between a fact ending 00:00Z and its successor starting
    // 05:00Z, and answered null inside a window a fact was valid for.
    const s = new FactStore();
    s.assert({ subject: 'j', predicate: 'taxRate', value: 2.75, validFrom: '2024-01-01', validTo: '2025-01-01', recordedAt: '2024-02-01', source: 'a' });
    s.assert({ subject: 'j', predicate: 'taxRate', value: 2.68, validFrom: '2025-1-1', validTo: '2026-1-1', recordedAt: '2025-02-01', source: 'b' });

    expect(s.value('j', 'taxRate', { validAt: '2025-01-01', knownAt: '2026-01-01' })).toBe(2.68);
    expect(s.value('j', 'taxRate', { validAt: '2024-12-31', knownAt: '2026-01-01' })).toBe(2.75);
    // The instant immediately before the boundary is still the earlier fact's,
    // whatever zone the browser is in.
    expect(s.value('j', 'taxRate', { validAt: new Date(asUtc('2025-01-01') - 1), knownAt: '2026-01-01' })).toBe(2.75);
  });

  it('stores an unpadded date zero-padded, so a text sort downstream still holds', () => {
    // sources.js and project.js sort and match these same values as TEXT:
    // '2025-06-01'.localeCompare('2025-1-1') < 0, so a June observation sorts
    // before January and the "latest" of a series is the wrong one.
    const s = new FactStore();
    const f = s.assert({ subject: 'm', predicate: 'employment', value: 1, validFrom: '2025-1-1', recordedAt: '2025-02-01', source: 'a' });
    expect(f.validFrom).toBe('2025-01-01');
    expect(f.validFrom.localeCompare('2025-06-01')).toBeLessThan(0);
  });

  it('leaves an already-padded date byte-identical', () => {
    // Persisted snapshots are checksummed over these strings.
    const s = new FactStore();
    const f = s.assert({ subject: 'm', predicate: 'p', value: 1, validFrom: '2025-06-01', validTo: '2026-06-01', recordedAt: '2025-07-01T12:00:00.000Z', source: 'a' });
    expect(f.validFrom).toBe('2025-06-01');
    expect(f.validTo).toBe('2026-06-01');
    expect(f.recordedAt).toBe('2025-07-01T12:00:00.000Z');
  });

  it('refuses a packed YYYYMMDD integer rather than dating the fact to 1970', () => {
    // A finite number is epoch milliseconds, so 20250101 read as one lands on
    // 1970-01-01T05:37Z — a confidently wrong instant, where the identical
    // value as the string '20250101' is correctly refused.
    const s = new FactStore();
    expect(() => s.assert({ subject: 'p', predicate: 'q', value: 1, validFrom: 20250101, recordedAt: '2026-01-01', source: 'a' }))
      .toThrow(/validFrom/);
  });

  it('still accepts Date.now() as a recordedAt', () => {
    const s = new FactStore();
    const now = Date.now();
    const f = s.assert({ subject: 'p', predicate: 'q', value: 1, validFrom: '2025-01-01', recordedAt: now, source: 'a' });
    expect(f.recordedAt).toBe(new Date(now).toISOString());
  });
});

describe('FactStore.history — the audit view names the fact the store answers with', () => {
  it('leads with the fact get() returns, whichever order the two were appended in', () => {
    // history() sorted on recordedAt and append order alone while resolve()
    // breaks a tie on the NARROWER valid window, so the audit view named a
    // different fact as current knowledge than the store answers with — the
    // exact disagreement the resolver was unified to prevent.
    const AT = { validAt: '2025-03-01', knownAt: '2026-06-01' };
    for (const boundedFirst of [true, false]) {
      const s = new FactStore();
      const bounded = { subject: 'x', predicate: 'p', value: 'bounded', validFrom: '2025-01-01', validTo: '2025-06-01', recordedAt: '2026-01-01', source: 'b' };
      const open = { subject: 'x', predicate: 'p', value: 'open', validFrom: '2025-01-01', validTo: null, recordedAt: '2026-01-01', source: 'a' };
      s.assertMany(boundedFirst ? [bounded, open] : [open, bounded]);
      expect(s.history('x', 'p')[0]).toBe(s.get('x', 'p', AT));
      expect(s.value('x', 'p', AT)).toBe('bounded');
    }
  });

  it('still leads with the latest knowledge when the transaction clocks differ', () => {
    const s = new FactStore();
    s.assert({ subject: 'x', predicate: 'p', value: 'old', validFrom: '2025-01-01', recordedAt: '2026-01-01', source: 'a' });
    s.assert({ subject: 'x', predicate: 'p', value: 'new', validFrom: '2025-01-01', recordedAt: '2026-05-01', source: 'b' });
    expect(s.history('x', 'p').map((f) => f.value)).toEqual(['new', 'old']);
  });
});
