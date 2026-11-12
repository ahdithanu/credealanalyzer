import { describe, it, expect } from 'vitest';
import { htmlToText, pageReader, decodeEntities } from '../text';
import { sampleSubjects, fnv1a } from '../sample';
import {
  assertDrawn, labelProblems, assertCompleteLabels, evidenceProblems, evidenceHolds, corpusItems,
} from '../labels';
import { isLabelled, assertLabelled } from '../edgar';
import { classifyPropertyType, FIELD_NAMES, spanHoldsNumber } from '../schema';
import { citationSupports } from '../score';

const ALL_NULL = Object.fromEntries(FIELD_NAMES.map((f) => [f, null]));

describe('htmlToText: the one canonical rendering', () => {
  it('puts each table row on one line with cells joined by " | "', () => {
    const html = '<table><tr><td>1290 Avenue of the Americas</td><td>70.0</td><td>%</td>'
      + '<td>$</td><td>2,089,000</td><td></td></tr></table>';
    // "%" glues to its number; "$" and empty cells are typographic and drop.
    expect(htmlToText(html)).toBe('1290 Avenue of the Americas | 70.0% | 2,089,000');
  });

  it('drops the inline XBRL header, scripts and styles', () => {
    const html = '<ix:header><ix:hidden>dei:EntityName</ix:hidden></ix:header>'
      + '<style>p{}</style><script>x()</script><p>Item 2. Properties</p>';
    expect(htmlToText(html)).toBe('Item 2. Properties');
  });

  it('decodes numeric and named entities, including the em dash filings use for nil', () => {
    expect(decodeEntities('&#8212; &#x2014; &amp; &nbsp;')).toBe('— — &  ');
    expect(htmlToText('<table><tr><td>&#8212;&#160;</td><td>8,315</td></tr></table>')).toBe('— | 8,315');
  });

  it('is deterministic', () => {
    const html = '<div>a</div><table><tr><td>x</td><td>1</td></tr></table>';
    expect(htmlToText(html)).toBe(htmlToText(html));
  });

  it('serves the document as page 1 and refuses any other page', () => {
    // A citation to page 2 must fail verification, not silently read page 1.
    const read = pageReader('abc');
    expect(read(1)).toBe('abc');
    expect(() => read(2)).toThrow();
    expect(citationSupports({ page: 2, start: 0, end: 3 }, 'abc', read)).toBe(false);
  });
});

describe('subject sampling', () => {
  const pop = ['606 Broadway', '1290 Avenue of the Americas', 'PENN 2', '90 Park Avenue', '770 Broadway'];

  it('is a pure function of entry id and population', () => {
    expect(sampleSubjects('e1', pop, 3)).toEqual(sampleSubjects('e1', pop, 3));
    expect(fnv1a('abc')).toBe(0x1a47e90b);
  });

  it('does not depend on the order the population is listed in', () => {
    expect(sampleSubjects('e1', [...pop].reverse(), 3)).toEqual(sampleSubjects('e1', pop, 3));
  });

  it('draws a longer sample as an extension of a shorter one, so a holdout never reshuffles dev', () => {
    expect(sampleSubjects('e1', pop, 5).slice(0, 3)).toEqual(sampleSubjects('e1', pop, 3));
  });

  it('draws differently for different filings', () => {
    expect(sampleSubjects('e1', pop, 5)).not.toEqual(sampleSubjects('e2', pop, 5));
  });

  it('refuses a population with duplicates', () => {
    expect(() => sampleSubjects('e1', ['a', 'b', 'a'], 2)).toThrow(/duplicate/);
  });
});

describe('assertDrawn: subjects are drawn, not chosen', () => {
  const population = ['a', 'b', 'c', 'd', 'e', 'f'];
  const drawn = sampleSubjects('e1', population, 3);
  const entry = (subjects) => ({
    id: 'e1', subjects: { population, items: subjects.map((subject) => ({ subject, groundTruth: ALL_NULL })) },
  });

  it('accepts the draw', () => {
    expect(() => assertDrawn(entry(drawn))).not.toThrow();
  });

  it('rejects a swapped-in subject', () => {
    const notDrawn = population.find((p) => !drawn.includes(p));
    expect(() => assertDrawn(entry([drawn[0], notDrawn, drawn[2]]))).toThrow(/drawn, not chosen/);
  });

  it('rejects the right subjects in the wrong order', () => {
    expect(() => assertDrawn(entry([drawn[1], drawn[0], drawn[2]]))).toThrow();
  });
});

describe('labelProblems: every field explicit, every value well-formed', () => {
  it('accepts an all-null label: nothing stated is a valid finding', () => {
    expect(labelProblems(ALL_NULL)).toEqual([]);
  });

  it('rejects a missing field, because a missing key scores as "not in the document"', () => {
    const { occupancy, ...rest } = ALL_NULL;
    expect(labelProblems(rest).join()).toMatch(/occupancy: not labelled/);
  });

  it('rejects a percentage written as a fraction', () => {
    expect(labelProblems({ ...ALL_NULL, occupancy: 0.913 }).join()).toMatch(/fraction/);
    expect(labelProblems({ ...ALL_NULL, occupancy: 91.3 })).toEqual([]);
    expect(labelProblems({ ...ALL_NULL, occupancy: 0 })).toEqual([]);
  });

  it('rejects an enum value outside the schema, a non-year, and an unknown field', () => {
    expect(labelProblems({ ...ALL_NULL, propertyType: 'Office / Retail' }).join()).toMatch(/not one of/);
    expect(labelProblems({ ...ALL_NULL, yearBuilt: 1911.5 }).join()).toMatch(/year/);
    expect(labelProblems({ ...ALL_NULL, cap_rate: 6 }).join()).toMatch(/not a schema field/);
  });

  it('assertCompleteLabels throws naming the subject', () => {
    const e = { id: 'e1', subjects: { items: [{ subject: 'PENN 2', groundTruth: { address: null } }] } };
    expect(() => assertCompleteLabels(e)).toThrow(/PENN 2/);
  });
});

describe('evidence: a stated value must be readable in the document', () => {
  const doc = '1290 Avenue of the Americas | 70.0% | Office / Retail | 91.3% | 2,089,000 | — | 2,089,000';
  const item = (truth, evidence) => ({ groundTruth: { ...ALL_NULL, ...truth }, evidence });

  it('accepts verbatim evidence that holds the value', () => {
    expect(evidenceProblems(doc, item(
      { squareFeet: 2_089_000, occupancy: 91.3, propertyType: 'mixed-use' },
      { squareFeet: '2,089,000 | — | 2,089,000', occupancy: 'Office / Retail | 91.3%', propertyType: 'Office / Retail' },
    ))).toEqual([]);
  });

  it('rejects a stated value with no evidence', () => {
    expect(evidenceProblems(doc, item({ squareFeet: 2_089_000 }, {})).join()).toMatch(/no evidence/);
  });

  it('rejects evidence that is not in the document', () => {
    expect(evidenceProblems(doc, item({ squareFeet: 2_089_000 }, { squareFeet: '2,089,000 sf' })).join())
      .toMatch(/not in the document/);
  });

  it('rejects evidence that does not hold the value', () => {
    expect(evidenceProblems(doc, item({ occupancy: 93.1 }, { occupancy: 'Office / Retail | 91.3%' })).join())
      .toMatch(/does not hold/);
  });

  it('judges a type through the mapping, so "Office / Retail" holds mixed-use and not retail', () => {
    expect(evidenceHolds('propertyType', 'Office / Retail', 'mixed-use')).toBe(true);
    expect(evidenceHolds('propertyType', 'Office / Retail', 'retail')).toBe(false);
  });

  it('needs no evidence for a field the document does not state', () => {
    expect(evidenceProblems(doc, item({}, {}))).toEqual([]);
  });
});

describe('property type mapping', () => {
  it.each([
    ['Office / Retail', 'mixed-use'],
    ['Retail / Residential', 'mixed-use'],
    ['Office', 'office'],
    ['Retail', 'retail'],
    ['Warehouse/Distribution', 'industrial'],
    ['Small Bay Industrial', 'industrial'],
    ['Our Multi-Family Properties', 'multifamily'],
    ['Tower Shopping Center', 'retail'],
    ['Land', 'other'],
    ['Studio', 'other'],
    ['Westpost Arlington, VA 22202', null],
  ])('%s -> %s', (stated, expected) => {
    expect(classifyPropertyType(stated)).toBe(expected);
  });

  it('grounds an extracted type through the same mapping, not literally', () => {
    const page = 'PENN 2 | 100.0% | Office / Retail | 79.5%';
    const span = { page: 1, start: page.indexOf('Office'), end: page.indexOf(' | 79') };
    const read = pageReader(page);
    expect(citationSupports(span, 'mixed-use', read, 'propertyType')).toBe(true);
    expect(citationSupports(span, 'office', read, 'propertyType')).toBe(false);
  });
});

describe('isLabelled for subject-labelled filings', () => {
  const base = { id: 'e1', groundTruth: null };

  it('counts a filing whose every subject carries ground truth', () => {
    expect(isLabelled({ ...base, subjects: { items: [{ subject: 'a', groundTruth: ALL_NULL }] } })).toBe(true);
  });

  it('does not count an empty subject list as labelled', () => {
    // It would score as nothing and let a run report numbers over a corpus it skipped.
    expect(isLabelled({ ...base, subjects: { items: [] } })).toBe(false);
    expect(() => assertLabelled([{ ...base, subjects: { items: [] } }])).toThrow(/unlabelled/);
  });

  it('does not count a filing with one unlabelled subject', () => {
    expect(isLabelled({
      ...base, subjects: { items: [{ subject: 'a', groundTruth: ALL_NULL }, { subject: 'b', groundTruth: null }] },
    })).toBe(false);
  });
});

describe('corpusItems', () => {
  it('flattens subjects and filters by set', () => {
    const manifest = [{
      id: 'e1', localPath: 'x.htm',
      subjects: { items: [
        { subject: 'a', set: 'dev', groundTruth: ALL_NULL },
        { subject: 'b', set: 'holdout', groundTruth: ALL_NULL },
      ] },
    }];
    expect(corpusItems(manifest).map((i) => i.id)).toEqual(['e1#a', 'e1#b']);
    expect(corpusItems(manifest, { set: 'holdout' }).map((i) => i.subject)).toEqual(['b']);
  });
});

describe('spanHoldsNumber: the shared literal check for labels and citations', () => {
  it.each([
    ['$12,400,000', 12_400_000, true],
    ['6.25%', 6.25, true],
    ['$123.5 million', 123_500_000, true],
    ['$123.5 million', 123_400_000, false],
    ['$1.2 billion', 1_200_000_000, true],
    ['$36,500,000', 36_400_000, false],
  ])('%s holds %d: %s', (span, value, expected) => {
    expect(spanHoldsNumber(span, value)).toBe(expected);
  });
});
