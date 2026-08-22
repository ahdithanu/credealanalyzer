import {
  FEATURES, DEFAULT_WEIGHTS, percentileRank, scoreMarket, scoreAll, fitWeights, featureValue,
} from '../marketScore';
import { rankNearbyMarkets, expansionCandidates } from '../siteSelection';
import { markets, findMarket } from '../markets';

describe('percentileRank', () => {
  it('places a value at its rank within the peer set', () => {
    expect(percentileRank(1, [1, 2, 3, 4])).toBeCloseTo(0.125, 6);
    expect(percentileRank(4, [1, 2, 3, 4])).toBeCloseTo(0.875, 6);
  });

  it('places the median at the midpoint', () => {
    expect(percentileRank(2, [1, 2, 3])).toBeCloseTo(0.5, 6);
  });

  it('returns 0.5 for a single-element peer set', () => {
    expect(percentileRank(7, [7])).toBe(0.5);
  });

  it('returns null rather than guessing for missing or non-finite input', () => {
    expect(percentileRank(null, [1, 2, 3])).toBeNull();
    expect(percentileRank(NaN, [1, 2, 3])).toBeNull();
    expect(percentileRank(1, [])).toBeNull();
  });

  it('ignores non-finite peers', () => {
    expect(percentileRank(2, [1, 2, 3, null, NaN, undefined])).toBeCloseTo(0.5, 6);
  });
});

describe('default weights', () => {
  it.each(Object.keys(DEFAULT_WEIGHTS))('sum to 1 for %s', (type) => {
    const sum = Object.values(DEFAULT_WEIGHTS[type]).reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it('cover every declared feature', () => {
    for (const type of Object.keys(DEFAULT_WEIGHTS)) {
      for (const f of FEATURES) {
        expect(DEFAULT_WEIGHTS[type]).toHaveProperty(f.key);
      }
    }
  });
});

describe('scoreMarket', () => {
  it('bounds the score to [0, 100] by construction', () => {
    for (const type of Object.keys(DEFAULT_WEIGHTS)) {
      for (const m of markets) {
        const { score } = scoreMarket(m, { propertyType: type });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    }
  });

  it('reconciles the score with the sum of its contributions', () => {
    const r = scoreMarket(findMarket('Austin'), { propertyType: 'multifamily' });
    const sum = r.contributions.reduce((s, c) => s + c.contribution, 0);
    expect(r.score).toBeCloseTo(50 + sum, 9);
  });

  it('orders contributions by magnitude so the UI can show the drivers first', () => {
    const { contributions } = scoreMarket(findMarket('Houston'), { propertyType: 'carwash' });
    const mags = contributions.map((c) => Math.abs(c.contribution));
    expect(mags).toEqual([...mags].sort((a, b) => b - a));
  });

  it('penalises a heavy supply pipeline for multifamily', () => {
    // Austin carries the heaviest pipeline in the peer set.
    const austin = scoreMarket(findMarket('Austin'), { propertyType: 'multifamily' });
    const supply = austin.contributions.find((c) => c.key === 'supplyPipeline');
    expect(supply.contribution).toBeLessThan(0);
  });

  it('penalises a heavy tax burden', () => {
    const corpus = scoreMarket(findMarket('Corpus Christi'), { propertyType: 'retail' });
    const tax = corpus.contributions.find((c) => c.key === 'effectiveTaxRate');
    expect(tax.contribution).toBeLessThan(0);
  });

  it('weights traffic count heavily for car wash and not at all for office', () => {
    const carwash = scoreMarket(findMarket('Miami'), { propertyType: 'carwash' });
    const office = scoreMarket(findMarket('Miami'), { propertyType: 'office' });
    expect(carwash.contributions.find((c) => c.key === 'trafficCount')).toBeDefined();
    expect(office.contributions.find((c) => c.key === 'trafficCount')).toBeUndefined();
  });

  it('reports full coverage when every weighted feature has data', () => {
    expect(scoreMarket(findMarket('Dallas'), { propertyType: 'retail' }).coverage).toBeCloseTo(1, 9);
  });

  it('degrades coverage and does not throw when features are missing', () => {
    const gappy = { ...findMarket('Dallas'), medianHHI: null, trafficCount: undefined };
    const r = scoreMarket(gappy, { propertyType: 'retail' });
    expect(r.coverage).toBeLessThan(1);
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.contributions.some((c) => c.missing)).toBe(true);
  });

  it('labels the default prior as unfitted', () => {
    expect(scoreMarket(findMarket('Tampa'), { propertyType: 'retail' }).provenance.fitted).toBe(false);
  });

  it('propagates the underlying data quality flag', () => {
    expect(scoreMarket(findMarket('Tampa'), { propertyType: 'retail' }).provenance.dataQuality).toBe('seed');
  });
});

describe('scoreAll', () => {
  it('ranks every market best first', () => {
    const ranked = scoreAll({ propertyType: 'industrial' });
    expect(ranked).toHaveLength(markets.length);
    const scores = ranked.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('produces different orderings for different property types', () => {
    const a = scoreAll({ propertyType: 'carwash' }).map((r) => r.marketKey);
    const b = scoreAll({ propertyType: 'office' }).map((r) => r.marketKey);
    expect(a).not.toEqual(b);
  });
});

describe('rankNearbyMarkets', () => {
  it('returns only markets inside the radius', () => {
    const { candidates } = rankNearbyMarkets('Houston, TX', { propertyType: 'carwash', radiusMiles: 200 });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(c.distance).toBeLessThanOrEqual(200);
  });

  it('excludes the origin market by default', () => {
    const { candidates } = rankNearbyMarkets('Dallas, TX', { propertyType: 'office' });
    expect(candidates.find((c) => c.market.key === 'dallas-tx')).toBeUndefined();
  });

  it('reports the score delta against the origin', () => {
    const { origin, candidates } = rankNearbyMarkets('Lubbock, TX', { propertyType: 'retail', radiusMiles: 1000 });
    for (const c of candidates) {
      expect(c.scoreDelta).toBeCloseTo(c.score - origin.score, 9);
    }
  });

  it('explains what differentiates each candidate from the origin', () => {
    const { candidates } = rankNearbyMarkets('Houston, TX', { propertyType: 'carwash', radiusMiles: 300 });
    for (const c of candidates) {
      expect(c.differentiators.length).toBeGreaterThan(0);
      for (const d of c.differentiators) expect(Number.isFinite(d.delta)).toBe(true);
    }
  });

  it('flags an unresolvable location instead of guessing a centroid', () => {
    const r = rankNearbyMarkets('Boise, ID', { propertyType: 'retail' });
    expect(r.unresolved).toBe(true);
    expect(r.candidates).toEqual([]);
  });

  it('respects the limit', () => {
    const { candidates } = rankNearbyMarkets('Tampa, FL', { propertyType: 'retail', radiusMiles: 5000, limit: 3 });
    expect(candidates).toHaveLength(3);
  });
});

describe('expansionCandidates', () => {
  it('returns only markets that beat the origin by the threshold', () => {
    const { origin, candidates } = expansionCandidates('Lubbock, TX', {
      propertyType: 'retail', radiusMiles: 2000, limit: 20, minScoreDelta: 5,
    });
    for (const c of candidates) expect(c.score - origin.score).toBeGreaterThanOrEqual(5);
  });

  it('returns nothing when the origin is already the best nearby market', () => {
    const { candidates } = expansionCandidates('Dallas, TX', {
      propertyType: 'industrial', radiusMiles: 60, minScoreDelta: 5,
    });
    expect(candidates).toEqual([]);
  });
});

describe('fitWeights', () => {
  /** Build a synthetic history where outcome is driven purely by population growth. */
  const synthetic = (n) => Array.from({ length: n }, (_, i) => {
    const market = markets[i % markets.length];
    return {
      market,
      propertyType: 'multifamily',
      outcome: market.popGrowth5y * 0.05,
    };
  });

  it('refuses to fit below the minimum observation count', () => {
    const r = fitWeights(synthetic(5));
    expect(r.error).toBe('insufficient-data');
    expect(r.required).toBe(12);
    expect(r.weights).toBeUndefined();
  });

  it('refuses an empty or malformed history', () => {
    expect(fitWeights([]).error).toBe('insufficient-data');
    expect(fitWeights(null).error).toBe('insufficient-data');
  });

  it('recovers the dominant driver from a synthetic history', () => {
    const r = fitWeights(synthetic(40), { lambda: 0.05 });
    expect(r.error).toBeUndefined();
    const ranked = Object.entries(r.weights).sort((a, b) => b[1] - a[1]);
    expect(ranked[0][0]).toBe('popGrowth5y');
  });

  it('returns a weight vector summing to 1 so it plugs into the scorecard', () => {
    const r = fitWeights(synthetic(40));
    const sum = Object.values(r.weights).reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it('produces a usable model that scores within bounds', () => {
    const fitted = fitWeights(synthetic(40));
    for (const m of markets) {
      const { score, provenance } = scoreMarket(m, { propertyType: 'multifamily', weights: fitted });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      expect(provenance.fitted).toBe(true);
      expect(provenance.model).toBe('ridge');
    }
  });

  it('reports in-sample R² with an explicit caveat', () => {
    const r = fitWeights(synthetic(40), { lambda: 0.05 });
    expect(r.provenance.r2).toBeGreaterThan(0.5);
    expect(r.provenance.caveat).toMatch(/out-of-sample/i);
    expect(r.provenance.observations).toBe(40);
  });

  it('shrinks weights toward uniform as lambda rises', () => {
    const spread = (w) => Math.max(...Object.values(w)) - Math.min(...Object.values(w));
    const light = fitWeights(synthetic(40), { lambda: 0.01 });
    const heavy = fitWeights(synthetic(40), { lambda: 500 });
    expect(spread(heavy.weights)).toBeLessThan(spread(light.weights));
  });

  it('surfaces features whose realised sign contradicts the assumed direction', () => {
    // Invert the relationship: outcomes are BEST where population growth is worst.
    const contrarian = Array.from({ length: 40 }, (_, i) => {
      const market = markets[i % markets.length];
      return { market, propertyType: 'multifamily', outcome: -market.popGrowth5y * 0.05 };
    });
    const r = fitWeights(contrarian, { lambda: 0.05 });
    expect(r.provenance.contradictions.map((c) => c.key)).toContain('popGrowth5y');
  });

  it('skips observations with a non-finite outcome', () => {
    const dirty = [...synthetic(40), { market: markets[0], propertyType: 'multifamily', outcome: NaN }];
    const r = fitWeights(dirty);
    expect(r.provenance.observations).toBe(40);
  });
});
