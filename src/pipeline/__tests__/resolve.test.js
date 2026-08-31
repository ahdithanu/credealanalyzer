import {
  normalizeEntityName, normalizeAddress, blockingKeys, candidatePairs,
  scorePair, resolveEntities, MATCH_THRESHOLDS, oversizedBlocks, MAX_BLOCK_SIZE,
} from '../resolve';

describe('normalizeEntityName', () => {
  it('collapses the punctuation variants of one legal form', () => {
    const forms = ['SUNBELT CAR WASH HOLDINGS LLC', 'Sunbelt Car Wash Holdings, L.L.C.', 'sunbelt car wash holdings llc'];
    const cores = forms.map((f) => normalizeEntityName(f).core);
    expect(new Set(cores).size).toBe(1);
  });

  it('separates the legal suffix from the identifying core', () => {
    const n = normalizeEntityName('Sunbelt Holdings, L.P.');
    expect(n.core).toBe('SUNBELT HOLDINGS');
    expect(n.suffix).toBe('LP');
  });

  it('expands the abbreviations assessor rolls actually use', () => {
    expect(normalizeEntityName('SUNBELT HLDGS LLC').core).toBe('SUNBELT HOLDINGS');
    expect(normalizeEntityName('KATY PROPS INC').core).toBe('KATY PROPERTIES');
    expect(normalizeEntityName('ALAMO INVS LP').core).toBe('ALAMO INVESTMENTS');
  });

  it('normalises ampersands to a word', () => {
    expect(normalizeEntityName('Feld & Rivera LLC').core).toBe('FELD AND RIVERA');
  });

  it('survives empty and non-string input', () => {
    expect(normalizeEntityName(null).core).toBe('');
    expect(normalizeEntityName('').tokens).toEqual([]);
  });

  it('does not strip a suffix-like word from the middle of a name', () => {
    expect(normalizeEntityName('CORP COMMONS RETAIL LLC').core).toBe('CORP COMMONS RETAIL');
  });
});

describe('normalizeAddress', () => {
  it('normalises street-type words to a single form', () => {
    expect(normalizeAddress('1200 Commerce Street, Suite 400'))
      .toBe(normalizeAddress('1200 COMMERCE ST STE 400'));
  });

  it('returns null for nothing', () => {
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
  });
});

describe('blocking', () => {
  it('gives two spellings of one entity a shared key', () => {
    const a = blockingKeys({ id: 1, name: 'SUNBELT CAR WASH HOLDINGS LLC' });
    const b = blockingKeys({ id: 2, name: 'Sunbelt Carwash Holdings, L.L.C.' });
    expect(a.some((k) => b.includes(k))).toBe(true);
  });

  it('blocks on a shared address even when names differ', () => {
    const a = blockingKeys({ id: 1, name: 'ALPHA LLC', address: '1200 Commerce St' });
    const b = blockingKeys({ id: 2, name: 'BETA LLC', address: '1200 COMMERCE STREET' });
    expect(a.filter((k) => k.startsWith('A:'))).toEqual(b.filter((k) => k.startsWith('A:')));
  });

  it('produces far fewer pairs than the full cross product', () => {
    const records = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `UNRELATED ENTITY ${i} LLC` }));
    // 200 records would be 19,900 pairs compared exhaustively.
    expect(candidatePairs(records).length).toBeLessThan(19_900 / 2);
  });

  it('never emits a pair twice or a record against itself', () => {
    const records = [
      { id: 'a', name: 'SUNBELT HOLDINGS LLC', address: '1 Main St' },
      { id: 'b', name: 'SUNBELT HOLDINGS LLC', address: '1 Main St' },
      { id: 'c', name: 'SUNBELT HOLDINGS LLC', address: '1 Main St' },
    ];
    const pairs = candidatePairs(records);
    const keys = pairs.map(([x, y]) => `${x.id}::${y.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(pairs.every(([x, y]) => x.id !== y.id)).toBe(true);
  });
});

describe('scorePair', () => {
  it('accepts identical normalised names', () => {
    const s = scorePair(
      { id: 1, name: 'SUNBELT CAR WASH HOLDINGS LLC' },
      { id: 2, name: 'Sunbelt Car Wash Holdings, L.L.C.' },
    );
    expect(s.decision).toBe('accept');
    expect(s.score).toBeGreaterThanOrEqual(MATCH_THRESHOLDS.accept);
  });

  it('rejects two clearly different entities', () => {
    const s = scorePair({ id: 1, name: 'SUNBELT HOLDINGS LLC' }, { id: 2, name: 'KATY LOGISTICS PARTNERS LP' });
    expect(s.decision).toBe('reject');
  });

  it('queues a partial name match for review rather than guessing', () => {
    const s = scorePair({ id: 1, name: 'SUNBELT CAR WASH HOLDINGS LLC' }, { id: 2, name: 'SUNBELT CAR WASH LLC' });
    expect(s.decision).toBe('review');
  });

  it('penalises a different legal form', () => {
    const same = scorePair({ id: 1, name: 'ALAMO RIDGE LLC' }, { id: 2, name: 'ALAMO RIDGE LLC' });
    const diff = scorePair({ id: 1, name: 'ALAMO RIDGE LLC' }, { id: 2, name: 'ALAMO RIDGE INC' });
    expect(diff.score).toBeLessThan(same.score);
    expect(diff.evidence.join(' ')).toMatch(/different legal form/);
  });

  it('lifts a match on a shared mailing address', () => {
    const without = scorePair({ id: 1, name: 'SUNBELT CAR WASH LLC' }, { id: 2, name: 'SUNBELT CAR WASH HOLDINGS LLC' });
    const with_ = scorePair(
      { id: 1, name: 'SUNBELT CAR WASH LLC', address: '1200 Commerce St' },
      { id: 2, name: 'SUNBELT CAR WASH HOLDINGS LLC', address: '1200 COMMERCE STREET' },
    );
    expect(with_.score).toBeGreaterThan(without.score);
    expect(with_.evidence).toContain('same mailing address');
  });

  it('always explains itself', () => {
    expect(scorePair({ id: 1, name: 'A LLC' }, { id: 2, name: 'B LLC' }).evidence.length).toBeGreaterThan(0);
  });
});

describe('resolveEntities', () => {
  const records = [
    { id: 'r1', name: 'SUNBELT CAR WASH HOLDINGS LLC', address: '1200 Commerce St' },
    { id: 'r2', name: 'Sunbelt Car Wash Holdings, L.L.C.', address: '1200 COMMERCE STREET' },
    { id: 'r3', name: 'SUNBELT CAR WASH HLDGS LLC' },
    { id: 'r4', name: 'KATY FREEWAY LOGISTICS PARTNERS LP' },
    { id: 'r5', name: 'ALAMO RIDGE APARTMENTS LLC' },
  ];

  it('merges the spelling variants into one cluster', () => {
    const { clusters } = resolveEntities(records);
    const sunbelt = clusters.find((c) => c.memberIds.includes('r1'));
    expect(sunbelt.memberIds.sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('keeps genuinely distinct entities apart', () => {
    const { clusters } = resolveEntities(records);
    expect(clusters).toHaveLength(3);
    expect(clusters.find((c) => c.memberIds.includes('r4')).memberIds).toEqual(['r4']);
  });

  it('picks the most complete surface form as the canonical name', () => {
    const { clusters } = resolveEntities(records);
    expect(clusters.find((c) => c.memberIds.includes('r1')).canonicalName)
      .toBe('SUNBELT CAR WASH HOLDINGS LLC');
  });

  it('does not merge anything sitting in the review band', () => {
    const ambiguous = [
      { id: 'a', name: 'SUNBELT CAR WASH HOLDINGS LLC' },
      { id: 'b', name: 'SUNBELT CAR WASH LLC' },
    ];
    const { clusters, review } = resolveEntities(ambiguous);
    expect(clusters).toHaveLength(2);          // left apart, deliberately
    expect(review).toHaveLength(1);
    expect(review[0].evidence.length).toBeGreaterThan(0);
  });

  it('orders the review queue by score so the best candidates surface first', () => {
    const many = [
      { id: 'a', name: 'SUNBELT CAR WASH HOLDINGS LLC' },
      { id: 'b', name: 'SUNBELT CAR WASH LLC' },
      { id: 'c', name: 'SUNBELT LLC' },
    ];
    const { review } = resolveEntities(many);
    const scores = review.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it('reports what it did', () => {
    const { stats } = resolveEntities(records);
    expect(stats.records).toBe(5);
    expect(stats.clusters).toBe(3);
    expect(stats.accepted).toBeGreaterThan(0);
  });

  it('handles a single record and an empty set', () => {
    expect(resolveEntities([{ id: 'x', name: 'ONLY LLC' }]).clusters).toHaveLength(1);
    expect(resolveEntities([]).clusters).toEqual([]);
  });

  it('is stable regardless of input order', () => {
    const forward = resolveEntities(records).clusters.map((c) => c.memberIds.sort().join(',')).sort();
    const backward = resolveEntities([...records].reverse()).clusters.map((c) => c.memberIds.sort().join(',')).sort();
    expect(backward).toEqual(forward);
  });
});

describe('block explosion', () => {
  // A shared leading token is common on real rolls ("TEXAS ...", "HOUSTON ...").
  // Left unbounded it turns blocking back into the full cross product.
  const crowded = Array.from({ length: 300 }, (_, i) => ({ id: `x${i}`, name: `TEXAS HOLDINGS ${i} LLC` }));

  it('drops a block too large to carry information', () => {
    const over = oversizedBlocks(crowded);
    expect(over.length).toBeGreaterThan(0);
    expect(over[0].size).toBeGreaterThan(MAX_BLOCK_SIZE);
  });

  it('keeps the pair count far below the cross product', () => {
    const full = (300 * 299) / 2;
    expect(candidatePairs(crowded).length).toBeLessThan(full / 10);
  });

  it('reports dropped blocks rather than hiding the lost recall', () => {
    expect(resolveEntities(crowded).stats.oversizedBlocks.length).toBeGreaterThan(0);
  });

  it('still resolves a small family inside a crowded set', () => {
    const mixed = [
      ...crowded,
      { id: 's1', name: 'SUNBELT CAR WASH HOLDINGS LLC' },
      { id: 's2', name: 'Sunbelt Car Wash Holdings, L.L.C.' },
    ];
    const cluster = resolveEntities(mixed).clusters.find((c) => c.memberIds.includes('s1'));
    expect(cluster.memberIds.sort()).toEqual(['s1', 's2']);
  });
});

describe('scoring calibration', () => {
  it('errs toward review rather than silent rejection for near matches', () => {
    // Holdco/opco naming is the common case, and it must reach a human.
    const pairs = [
      ['SUNBELT CAR WASH HOLDINGS LLC', 'SUNBELT CAR WASH LLC'],
      ['KATY FREEWAY LOGISTICS PARTNERS LP', 'KATY FREEWAY LOGISTICS LP'],
    ];
    for (const [a, b] of pairs) {
      expect(scorePair({ id: 1, name: a }, { id: 2, name: b }).decision).toBe('review');
    }
  });

  it('still rejects pairs with no meaningful overlap', () => {
    const pairs = [
      ['SUNBELT CAR WASH HOLDINGS LLC', 'KATY FREEWAY LOGISTICS LP'],
      ['ALAMO RIDGE APARTMENTS LLC', 'PLANO NORTH CAMPUS LLC'],
    ];
    for (const [a, b] of pairs) {
      expect(scorePair({ id: 1, name: a }, { id: 2, name: b }).decision).toBe('reject');
    }
  });

  it('does not auto-accept on a shared address alone', () => {
    // Registered-agent addresses are shared by thousands of unrelated SPEs.
    const s = scorePair(
      { id: 1, name: 'ALPHA PROPERTIES LLC', address: '1200 Commerce St' },
      { id: 2, name: 'ZULU LOGISTICS LP', address: '1200 Commerce St' },
    );
    expect(s.decision).toBe('reject');
  });
});
