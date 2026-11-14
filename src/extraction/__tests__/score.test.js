import { describe, it, expect } from 'vitest';
import {
  scoreDocument, scoreCorpus, citationSupports, calibration, abstained,
  OUTCOME, BASELINES,
} from '../score';
import { valuesAgree, NOT_IN_DOCUMENT } from '../schema';

// One page of a document, with known offsets, so citation checks are exact.
const PAGE_7 = 'The property at 100 Main Street sold for $12,400,000 at a 6.25% cap rate.';
const pageText = (p) => {
  if (p !== 7) throw new Error(`no such page: ${p}`);
  return PAGE_7;
};
const spanOf = (needle) => ({
  page: 7,
  start: PAGE_7.indexOf(needle),
  end: PAGE_7.indexOf(needle) + needle.length,
});

describe('abstention is the absence of a value, however it is spelled', () => {
  it.each([
    ['missing key', undefined],
    ['explicit null', null],
    ['null value', { value: null, quality: 'sourced' }],
    ['undefined value', { value: undefined, quality: 'sourced' }],
  ])('%s counts as abstention', (_label, answer) => {
    expect(abstained(answer)).toBe(true);
  });

  it('a value of 0 is an answer, not an abstention', () => {
    // The bug this guards: `!answer.value` would swallow a genuine zero, and
    // occupancy of 0% on a vacant building is a real, extractable fact.
    expect(abstained({ value: 0, quality: 'sourced' })).toBe(false);
  });
});

describe('the five outcomes', () => {
  const truth = { squareFeet: 10_000, purchasePrice: NOT_IN_DOCUMENT };

  it('scores a correct answer to a stated field as a hit', () => {
    const { byField } = scoreDocument({
      predicted: { squareFeet: { value: 10_000, quality: 'sourced' } }, truth,
    });
    expect(byField.squareFeet.outcome).toBe(OUTCOME.HIT);
  });

  it('scores a wrong answer to a stated field as an error', () => {
    const { byField } = scoreDocument({
      predicted: { squareFeet: { value: 48_000, quality: 'sourced' } }, truth,
    });
    expect(byField.squareFeet.outcome).toBe(OUTCOME.ERROR);
  });

  it('scores silence on a stated field as a miss', () => {
    const { byField } = scoreDocument({ predicted: {}, truth });
    expect(byField.squareFeet.outcome).toBe(OUTCOME.MISS);
  });

  it('scores an answer to an absent field as a hallucination', () => {
    // The field the harness exists for. The document never states a price;
    // the extractor produced one anyway.
    const { byField } = scoreDocument({
      predicted: { purchasePrice: { value: 12_400_000, quality: 'sourced' } }, truth,
    });
    expect(byField.purchasePrice.outcome).toBe(OUTCOME.HALLUCINATION);
  });

  it('scores silence on an absent field as a correct abstention', () => {
    const { byField } = scoreDocument({ predicted: {}, truth });
    expect(byField.purchasePrice.outcome).toBe(OUTCOME.CORRECT_ABSTENTION);
  });
});

describe('citation verification', () => {
  it('accepts a span that contains the number, separators and all', () => {
    expect(citationSupports(spanOf('$12,400,000'), 12_400_000, pageText)).toBe(true);
  });

  it('accepts a span containing a percentage', () => {
    expect(citationSupports(spanOf('6.25%'), 6.25, pageText)).toBe(true);
  });

  it('rejects a span that does not contain the value', () => {
    // The right answer behind a fabricated pointer. This is the case the whole
    // file exists for: correct, and still not grounded.
    expect(citationSupports(spanOf('100 Main Street'), 12_400_000, pageText)).toBe(false);
  });

  it('rejects a span running past the end of the page rather than clamping', () => {
    expect(citationSupports({ page: 7, start: 0, end: PAGE_7.length + 50 }, 12_400_000, pageText))
      .toBe(false);
  });

  it('rejects a citation to a page that does not exist', () => {
    expect(citationSupports({ page: 99, start: 0, end: 10 }, 12_400_000, pageText)).toBe(false);
  });

  it.each([
    ['no citation at all', undefined],
    ['non-integer offsets', { page: 7, start: 1.5, end: 9 }],
    ['inverted span', { page: 7, start: 20, end: 4 }],
  ])('rejects %s', (_label, citation) => {
    expect(citationSupports(citation, 12_400_000, pageText)).toBe(false);
  });

  it('marks a correct value with a bad citation as ungrounded', () => {
    const { byField, ungrounded } = scoreDocument({
      predicted: {
        purchasePrice: {
          value: 12_400_000,
          quality: 'sourced',
          citation: spanOf('100 Main Street'), // points at the address, not the price
        },
      },
      truth: { purchasePrice: 12_400_000 },
      pageText,
    });
    expect(byField.purchasePrice.outcome).toBe(OUTCOME.HIT);   // the value is right
    expect(byField.purchasePrice.grounded).toBe(false);        // the claim is not
    expect(ungrounded).toContain('purchasePrice');
  });

  it('does not check citations on a field claiming to be an estimate', () => {
    // An estimate is not claiming to be in the document, so it cannot be
    // ungrounded. Demanding a citation here would punish the honest label.
    const { byField } = scoreDocument({
      predicted: { capRate: { value: 6.25, quality: 'estimate' } },
      truth: { capRate: 6.25 },
      pageText,
    });
    expect(byField.capRate.grounded).toBeNull();
  });

  it('leaves groundedness null when no document text is supplied', () => {
    // "Not checked" must never aggregate as "passed".
    const { byField } = scoreDocument({
      predicted: { capRate: { value: 6.25, quality: 'sourced', citation: spanOf('6.25%') } },
      truth: { capRate: 6.25 },
    });
    expect(byField.capRate.grounded).toBeNull();
    expect(scoreCorpus([scoreDocument({
      predicted: { capRate: { value: 6.25, quality: 'sourced', citation: spanOf('6.25%') } },
      truth: { capRate: 6.25 },
    })]).groundedness).toBeNull();
  });
});

describe('comparator tolerances', () => {
  it('treats the same price written two ways as equal', () => {
    expect(valuesAgree('purchasePrice', 12_400_000, 12_400_000)).toBe(true);
    expect(valuesAgree('purchasePrice', 12_401_000, 12_400_000)).toBe(true); // within 0.5%
  });

  it('does not absorb a transposed digit', () => {
    expect(valuesAgree('purchasePrice', 14_200_000, 12_400_000)).toBe(false);
  });

  it('measures cap rate in points, not relatively', () => {
    expect(valuesAgree('capRate', 6.3, 6.25)).toBe(true);
    expect(valuesAgree('capRate', 6.45, 6.25)).toBe(false);
  });

  it('rejects a percent expressed as a fraction', () => {
    // 0.0625 is the single most likely unit bug in this domain, and accepting
    // it here would let the whole pipeline carry the wrong convention.
    expect(valuesAgree('capRate', 0.0625, 6.25)).toBe(false);
  });

  it('allows no tolerance at all on a year', () => {
    expect(valuesAgree('yearBuilt', 1998, 1998)).toBe(true);
    expect(valuesAgree('yearBuilt', 1999, 1998)).toBe(false);
  });

  it('normalises whitespace and case in text but not abbreviations', () => {
    expect(valuesAgree('address', '100  MAIN STREET', '100 Main Street')).toBe(true);
    expect(valuesAgree('address', '100 Main St', '100 Main Street')).toBe(false);
  });

  it('throws on an unknown field rather than scoring it as wrong', () => {
    expect(() => valuesAgree('noSuchField', 1, 1)).toThrow(/unknown field/);
  });
});

describe('corpus rates use the right denominators', () => {
  // Two documents. Doc A states square feet and nothing else; doc B states
  // square feet and a price. The extractor answers square feet correctly in
  // both and invents a price in doc A.
  const docs = [
    scoreDocument({
      predicted: {
        squareFeet: { value: 10_000, quality: 'estimate' },
        purchasePrice: { value: 9_999, quality: 'estimate' },
      },
      truth: { squareFeet: 10_000 },
    }),
    scoreDocument({
      predicted: { squareFeet: { value: 20_000, quality: 'estimate' } },
      truth: { squareFeet: 20_000, purchasePrice: 5_000_000 },
    }),
  ];
  const corpus = scoreCorpus(docs);

  it('divides hallucinations by the absent fields, not by every field', () => {
    // Doc A: 7 absent fields, 1 invented. Doc B: 6 absent, 0 invented.
    expect(corpus.counts[OUTCOME.HALLUCINATION]).toBe(1);
    expect(corpus.hallucinationRate).toBeCloseTo(1 / 13, 10);
  });

  it('divides answer accuracy by what it answered, not by what existed', () => {
    expect(corpus.counts[OUTCOME.HIT]).toBe(2);
    expect(corpus.counts[OUTCOME.ERROR]).toBe(0);
    expect(corpus.answerAccuracy).toBe(1);
  });

  it('reports coverage separately, so perfect accuracy cannot hide a miss', () => {
    // Doc B's price was in the document and was not attempted.
    expect(corpus.counts[OUTCOME.MISS]).toBe(1);
    expect(corpus.coverage).toBeCloseTo(2 / 3, 10);
  });

  it('returns null, not zero, for a rate with no denominator', () => {
    const empty = scoreCorpus([scoreDocument({ predicted: {}, truth: {} })]);
    expect(empty.answerAccuracy).toBeNull();
    expect(empty.coverage).toBeNull();
  });
});

describe('the two baselines bracket any real extractor', () => {
  const truth = { squareFeet: 10_000, purchasePrice: NOT_IN_DOCUMENT };

  it('abstaining always is perfect on hallucination and useless on coverage', () => {
    const s = scoreCorpus([scoreDocument({ predicted: BASELINES.abstainAlways(), truth })]);
    expect(s.hallucinationRate).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.answerAccuracy).toBeNull(); // it answered nothing; there is no accuracy to report
  });

  it('guessing always is perfect on coverage and terrible on hallucination', () => {
    // Every field filled — a filler that leaves a field undefined is an
    // abstention, which would make this baseline look better than it is.
    const s = scoreCorpus([scoreDocument({
      predicted: BASELINES.guessAlways({
        address: '1 Nowhere Rd', propertyType: 'office', squareFeet: 10_000,
        yearBuilt: 1990, purchasePrice: 1, netOperatingIncome: 1,
        capRate: 1, occupancy: 1,
      }),
      truth,
    })]);
    expect(s.coverage).toBe(1);
    expect(s.hallucinationRate).toBe(1); // all 7 absent fields invented
  });
});

describe('calibration', () => {
  it('reports zero error when confidence matches accuracy', () => {
    // Ten samples at 0.9 confidence, nine of them correct.
    const samples = Array.from({ length: 10 }, (_, i) => ({ confidence: 0.9, correct: i < 9 }));
    expect(calibration(samples).ece).toBeCloseTo(0, 10);
  });

  it('catches overconfidence', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ confidence: 0.9, correct: i < 5 }));
    expect(calibration(samples).ece).toBeCloseTo(0.4, 10);
  });

  it('keeps the buckets so direction is visible, not just magnitude', () => {
    const { buckets } = calibration([
      { confidence: 0.1, correct: false },
      { confidence: 0.9, correct: false },
    ]);
    expect(buckets).toHaveLength(2);
    expect(buckets[1].accuracy).toBe(0); // the dangerous one: confident and wrong
  });

  it('returns null rather than zero with nothing to calibrate', () => {
    expect(calibration([]).ece).toBeNull();
  });

  it('excludes an answered field that carried no confidence', () => {
    // Found by mutation: dropping this guard let a confidence-less answer into
    // the samples, where Math.max(null, 0) parks it in the 0.0-0.2 bucket. A
    // correct answer in the least-confident bucket manufactures an ECE of 1.0
    // out of a number the extractor simply never reported.
    const doc = scoreDocument({
      predicted: { squareFeet: { value: 10_000, quality: 'estimate' } },
      truth: { squareFeet: 10_000 },
    });
    expect(scoreCorpus([doc]).calibration.ece).toBeNull();
  });

  it('excludes abstentions from calibration', () => {
    // A field it declined has no confidence to be calibrated against, and
    // counting it as a confident miss would make timidity look like error.
    const doc = scoreDocument({ predicted: {}, truth: { squareFeet: 10_000 } });
    expect(scoreCorpus([doc]).calibration.ece).toBeNull();
  });
});
