/**
 * The market reference table, and the claims it is allowed to make.
 *
 * Almost nothing here is about a particular number — the numbers are seed and
 * estimate data and pinning them would be pinning a guess. What is pinned is
 * the shape of the honesty: that no record claims to be sourced while it holds
 * invented fields, that a value exists everywhere the scorer will read one, and
 * that a city name shared with another state cannot quietly resolve here.
 */

import {
  markets, findMarket, getMarket, resolveTaxRate, getPropertyTaxRate,
  statedState, fieldQuality, buildRecord, dataQualityMix, MARKET_DATA_FIELDS, DATA_QUALITY_ORDER,
  DEFAULT_TAX_RATE,
} from '../markets';
import { FEATURES, featureValue, scoreMarket } from '../marketScore';
import { propertyTypes } from '../propertyTypes';

const PROPERTY_TYPES = Object.keys(propertyTypes);

describe('every record is complete enough to be scored', () => {
  it('carries a finite value for every field the scorer reads', () => {
    // percentileRank drops non-finite values, so a missing field does not throw
    // — it silently shrinks the peer set for that one feature and shifts every
    // other market's percentile. An absence here is invisible at the call site.
    for (const m of markets) {
      for (const f of FEATURES) {
        if (f.key === 'marketCapRate') continue;
        expect(Number.isFinite(m[f.key]), `${m.key}.${f.key}`).toBe(true);
      }
      for (const type of PROPERTY_TYPES) {
        expect(Number.isFinite(featureValue(m, 'marketCapRate', type)), `${m.key} cap ${type}`)
          .toBe(true);
      }
    }
  });

  it('has a unique key and a plausible location', () => {
    expect(new Set(markets.map((m) => m.key)).size).toBe(markets.length);
    for (const m of markets) {
      expect(m.key, m.city).toBe(`${m.city.toLowerCase().replace(/[^a-z]+/g, '-')}-${m.state.toLowerCase()}`);
      // Continental US, loosely. A transposed lat/lng lands in the Indian Ocean
      // and siteSelection's distance ranking quietly inverts.
      expect(m.lat, m.key).toBeGreaterThan(24);
      expect(m.lat, m.key).toBeLessThan(50);
      expect(m.lng, m.key).toBeLessThan(-66);
      expect(m.lng, m.key).toBeGreaterThan(-125);
    }
  });

  it('says whether population is a metro or a city figure', () => {
    // The field is documented as metro population and six records carry city
    // population for a submarket of a larger metro. Recorded rather than left
    // to be inferred from the size, because inferring it is how Plano reads as
    // a 290,000-person market instead of a Dallas–Fort Worth submarket.
    for (const m of markets) {
      expect(['metro', 'city'], m.key).toContain(m.populationBasis);
    }
    expect(markets.filter((m) => m.populationBasis === 'city').length).toBeGreaterThan(0);
  });
});

describe('provenance is per field, and a record is only as good as its worst one', () => {
  it('grades every data field on every record', () => {
    for (const m of markets) {
      for (const field of MARKET_DATA_FIELDS) {
        expect(DATA_QUALITY_ORDER, `${m.key}.${field}`).toContain(fieldQuality(m, field));
      }
      // A field nobody graded must not read as the best quality by default.
      expect(fieldQuality(m, 'aFieldThatDoesNotExist')).toBe('seed');
    }
  });

  it('reports the WEAKEST field, never the best one', () => {
    for (const m of markets) {
      const worst = DATA_QUALITY_ORDER
        .find((q) => MARKET_DATA_FIELDS.some((f) => fieldQuality(m, f) === q));
      expect(m.provenance.dataQuality, m.key).toBe(worst);
    }
  });

  it('nothing claims to be sourced, because nothing has been', () => {
    // api.census.gov is not reachable from the environment this was written in,
    // so `npm run markets` has never run. The day it does, this assertion is
    // the one to change — deliberately, not by a record quietly flipping.
    for (const m of markets) {
      expect(m.provenance.dataQuality, m.key).toBe('seed');
      expect(m.provenance.asOf, m.key).toBeNull();
    }
  });

  it('some fields ARE better than seed, and the record still reads seed', () => {
    // The point of per-field provenance: a good tax rate does not launder the
    // eight invented fields beside it, and it is not thrown away either.
    const columbus = getMarket('columbus-oh');
    expect(fieldQuality(columbus, 'effectiveTaxRate')).toBe('estimate');
    expect(fieldQuality(columbus, 'supplyPipeline')).toBe('seed');
    expect(columbus.provenance.dataQuality).toBe('seed');
  });
});

describe('a city name shared with another state cannot resolve here', () => {
  it('refuses Columbus, GA rather than answering with Columbus, OH', () => {
    // 1.50% against Franklin County's ~2% commercial rate is roughly a quarter
    // of the tax line — and the wrong answer is indistinguishable from a right
    // one, because it comes back as a confident market match.
    expect(findMarket('Columbus, OH')?.key).toBe('columbus-oh');
    expect(findMarket('Columbus, GA')).toBeNull();
    expect(findMarket('Miami, OK')).toBeNull();
    expect(findMarket('Miami, FL')?.key).toBe('miami-fl');
  });

  it('reads Kansas City on the state, not on the name', () => {
    expect(findMarket('Kansas City, MO')?.key).toBe('kansas-city-mo');
    expect(findMarket('Kansas City, KS')).toBeNull();
    // …and Kansas still resolves, through the state fallback rather than a
    // market on the wrong side of the line.
    expect(resolveTaxRate('Kansas City, KS').basis).toBe('state');
  });

  it('resolves a city written with and without its abbreviating period', () => {
    expect(findMarket('St. Louis, MO')?.key).toBe('st-louis-mo');
    expect(findMarket('St Louis, MO')?.key).toBe('st-louis-mo');
  });

  it('reads a trailing state that this file carries no markets in', () => {
    // The guard only works if an unknown state is still recognised AS a state.
    expect(statedState('Columbus, GA')).toBe('ga');
    expect(statedState('Boise, ID')).toBe('id');
    expect(statedState('Columbus')).toBeNull();
  });

  it('still matches on the city alone when no state is named', () => {
    expect(findMarket('Columbus')?.key).toBe('columbus-oh');
    expect(findMarket('a site near Grand Rapids')?.key).toBe('grand-rapids-mi');
  });
});

describe('a location off the map degrades in the right order', () => {
  it('every state with a market has a state-level fallback', () => {
    // Without one, a deal in Toledo falls past Ohio to DEFAULT_TAX_RATE — a
    // national placeholder — while the file plainly knows what Ohio charges.
    for (const state of new Set(markets.map((m) => m.state))) {
      const resolved = resolveTaxRate(`Nowheresville, ${state}`);
      expect(resolved.basis, state).toBe('state');
      expect(resolved.rate, state).not.toBe(DEFAULT_TAX_RATE);
    }
  });

  it('labels the state average an estimate and the default a placeholder', () => {
    // DEFAULT_TAX_RATE is not an estimate of anything. It is a number standing
    // where a number should be, and calling it an estimate would put it one
    // rung above what it is.
    expect(resolveTaxRate('Nowheresville, OH').provenance.dataQuality).toBe('estimate');
    expect(resolveTaxRate('Atlantis').provenance.dataQuality).toBe('seed');
    expect(getPropertyTaxRate('Atlantis')).toBe(DEFAULT_TAX_RATE);
  });
});

describe('the Midwest is reachable at all, which was the point', () => {
  const MIDWEST = ['OH', 'IN', 'MI', 'IL', 'MO', 'WI', 'MN', 'IA', 'NE'];

  it('carries markets across the Midwest, not just the Sunbelt', () => {
    const covered = new Set(markets.map((m) => m.state));
    for (const state of MIDWEST) expect(covered, state).toContain(state);
  });

  it('scores a Midwest market against the whole peer set', () => {
    for (const key of ['columbus-oh', 'indianapolis-in', 'kansas-city-mo']) {
      const scored = scoreMarket(getMarket(key), { propertyType: 'retail' });
      expect(scored.score, key).toBeGreaterThanOrEqual(0);
      expect(scored.score, key).toBeLessThanOrEqual(100);
      // Full coverage, because every field is present — see the first test.
      expect(scored.coverage, key).toBe(1);
      expect(scored.provenance.dataQuality, key).toBe('seed');
    }
  });

  it('carries a COMMERCIAL tax rate, which in these states is the higher one', () => {
    // Indiana's circuit breaker caps homestead at 1% of gross assessed value
    // and commercial at 3%; Cook County assesses commercial at 25% of market
    // against residential's 10%. A residential rate — what a published "tax by
    // metro" table means — understates a strip centre's tax by a third there.
    // These are not near the residential figures, and that is deliberate.
    expect(getMarket('indianapolis-in').effectiveTaxRate).toBeGreaterThan(1.5);
    expect(getMarket('chicago-il').effectiveTaxRate).toBeGreaterThan(2.5);
    expect(getMarket('detroit-mi').effectiveTaxRate).toBeGreaterThan(2.5);
  });
});

describe('the sourced overlay, when there is one', () => {
  /**
   * marketsSourced.js is empty — `npm run markets` has never run against a
   * reachable api.census.gov — so nothing in the shipped table exercises this
   * path. Tested through the seam instead, because the alternative is a merge
   * that gets its first run in production.
   */
  const base = {
    key: 'columbus-oh', city: 'Columbus', state: 'OH', lat: 39.96, lng: -82.99,
    populationBasis: 'city', effectiveTaxRate: 2.0, population: 999, popGrowth5y: 9.9,
    employmentGrowth: 1.5, medianHHI: 11111, supplyPipeline: 2.8, rentGrowth: 2.8,
    trafficCount: 34000, marketCapRate: { retail: 7.3 },
  };
  const overlay = {
    cbsa: '18140',
    cbsaName: 'Columbus, OH Metro Area',
    asOf: 'ACS 5-year 2022',
    fields: { population: 2151017, medianHHI: 76208, popGrowth5y: 0.94, populationBasis: 'metro' },
  };

  it('overrides the seed value with the sourced one', () => {
    const record = buildRecord(base, ['effectiveTaxRate'], overlay);
    expect(record.population).toBe(2151017);
    expect(record.medianHHI).toBe(76208);
    expect(record.populationBasis).toBe('metro');
    // Untouched fields keep their seed values rather than disappearing.
    expect(record.trafficCount).toBe(34000);
  });

  it('marks exactly the overridden fields sourced, and nothing else', () => {
    const record = buildRecord(base, ['effectiveTaxRate'], overlay);
    expect(record.provenance.fields.population).toBe('sourced');
    expect(record.provenance.fields.medianHHI).toBe('sourced');
    expect(record.provenance.fields.popGrowth5y).toBe('sourced');
    expect(record.provenance.fields.effectiveTaxRate).toBe('estimate');
    expect(record.provenance.fields.supplyPipeline).toBe('seed');
  });

  it('still reads seed overall, because five fields have no free source', () => {
    // Supply pipeline, rent growth, cap rates, traffic and employment growth
    // are CoStar, Yardi, the broker surveys, a state DOT and BLS. Sourcing the
    // Census fields does not make the record citable, and the one flag every
    // consumer branches on must not say that it does.
    const record = buildRecord(base, ['effectiveTaxRate'], overlay);
    expect(record.provenance.dataQuality).toBe('seed');
    expect(record.provenance.asOf).toBe('ACS 5-year 2022');
    // The Census's own name for the CBSA rides along, so a transposed code
    // stays visible after the fact rather than only during the run.
    expect(record.provenance.cbsaName).toBe('Columbus, OH Metro Area');
  });

  it('reads sourced overall once every field is covered', () => {
    const everything = {
      asOf: 'ACS 5-year 2022',
      fields: Object.fromEntries(MARKET_DATA_FIELDS.map((f) => [f, 1])),
    };
    expect(buildRecord(base, [], everything).provenance.dataQuality).toBe('sourced');
  });
});

describe('counting how much of the table is real', () => {
  const record = (qualities) => ({
    key: 'x', provenance: { fields: Object.fromEntries(MARKET_DATA_FIELDS.map((f, i) => [f, qualities[i % qualities.length]])) },
  });

  it('counts every field on every market, not the first of either', () => {
    // With nothing sourced yet, a tally over one market and a tally over all
    // thirty-six both print 0%. Only a set that spans the qualities can tell
    // a correct count from a truncated one.
    const mix = dataQualityMix([record(['sourced']), record(['seed'])]);
    expect(mix.markets).toBe(2);
    expect(mix.total).toBe(2 * MARKET_DATA_FIELDS.length);
    expect(mix.counts.sourced).toBe(MARKET_DATA_FIELDS.length);
    expect(mix.counts.seed).toBe(MARKET_DATA_FIELDS.length);
    expect(mix.sourcedPct).toBeCloseTo(50, 6);
  });

  it('does not let an estimate count as a citation', () => {
    const mix = dataQualityMix([record(['estimate'])]);
    expect(mix.sourcedPct).toBe(0);
    expect(mix.estimatePct).toBe(100);
  });

  it('reports the shipped table as entirely unsourced', () => {
    const mix = dataQualityMix();
    expect(mix.markets).toBe(markets.length);
    expect(mix.sourcedPct).toBe(0);
    expect(mix.counts.estimate).toBeGreaterThan(0);
    expect(mix.counts.seed).toBeGreaterThan(0);
  });

  it('survives an empty set without dividing by zero', () => {
    const mix = dataQualityMix([]);
    expect(mix.total).toBe(0);
    expect(mix.sourcedPct).toBe(0);
  });
});
