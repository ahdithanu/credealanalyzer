import { describe, it, expect } from 'vitest';
import {
  padCik, submissionsUrl, filingUrl, selectFilings, manifestEntry, assertLabelled,
  DEFAULT_USER_AGENT,
} from '../edgar';

describe('CIK padding', () => {
  it.each([
    ['899689', '0000899689'],
    ['0000899689', '0000899689'],
    ['CIK0000899689', '0000899689'],
    [899689, '0000899689'],
  ])('pads %s', (input, expected) => {
    expect(padCik(input)).toBe(expected);
  });

  it.each([['', 'empty'], ['abc', 'no digits'], ['12345678901', 'too long']])(
    'refuses %s (%s)', (input) => {
      expect(() => padCik(input)).toThrow();
    });
});

describe('URL construction', () => {
  it('pads the CIK in a submissions URL', () => {
    expect(submissionsUrl('899689'))
      .toBe('https://data.sec.gov/submissions/CIK0000899689.json');
  });

  it('strips padding from the CIK but keeps the dashed accession as the filename', () => {
    // The archive path wants the bare CIK, the UNDASHED accession as the
    // folder, and the document name as filed. Each of the three is a separate
    // chance to 404.
    expect(filingUrl({
      cik: '0000899689',
      accessionNumber: '0000899689-24-000012',
      document: 'vno-20231231.htm',
    })).toBe('https://www.sec.gov/Archives/edgar/data/899689/000089968924000012/vno-20231231.htm');
  });
});

describe('selecting filings from the parallel arrays', () => {
  const submissions = {
    filings: {
      recent: {
        form: ['10-K', '8-K', '10-Q', '10-K', '10-K'],
        accessionNumber: ['a-1', 'a-2', 'a-3', 'a-4', 'a-5'],
        primaryDocument: ['one.htm', 'two.htm', 'three.htm', '', 'five.htm'],
        reportDate: ['2024-12-31', '2024-06-01', '2024-09-30', '2023-12-31', '2022-12-31'],
        filingDate: ['2025-02-20', '2024-06-03', '2024-11-01', '2024-02-20', '2023-02-20'],
        primaryDocDescription: ['10-K', '8-K', '10-Q', '10-K', '10-K'],
      },
    },
  };

  it('keeps only the requested form and transposes to records', () => {
    const got = selectFilings(submissions);
    expect(got.map((f) => f.accessionNumber)).toEqual(['a-1', 'a-5']);
    expect(got[0]).toMatchObject({ form: '10-K', document: 'one.htm', reportDate: '2024-12-31' });
  });

  it('skips a filing with no primary document rather than emitting an unfetchable row', () => {
    // a-4 is a 10-K with an empty primaryDocument. Including it would make
    // `limit` promise more documents than the fetch can deliver.
    expect(selectFilings(submissions).map((f) => f.accessionNumber)).not.toContain('a-4');
  });

  it('honours limit', () => {
    expect(selectFilings(submissions, { limit: 1 })).toHaveLength(1);
  });

  it('can select several form types', () => {
    expect(selectFilings(submissions, { forms: ['10-K', '8-K'], limit: 10 }))
      .toHaveLength(3);
  });

  it('is case-insensitive about form names', () => {
    expect(selectFilings(submissions, { forms: ['10-k'] })).toHaveLength(2);
  });

  it.each([
    ['no submissions at all', undefined],
    ['no filings key', {}],
    ['no recent key', { filings: {} }],
  ])('returns an empty list for %s', (_label, input) => {
    expect(selectFilings(input)).toEqual([]);
  });
});

describe('manifest entries', () => {
  const filing = {
    form: '10-K',
    accessionNumber: '0000899689-24-000012',
    document: 'vno-20231231.htm',
    reportDate: '2023-12-31',
    filingDate: '2024-02-20',
  };

  it('starts unlabelled, with null and not an empty object', () => {
    // The distinction is load-bearing: {} means a human looked and found
    // nothing extractable, which scores as all-correct-abstentions.
    const e = manifestEntry({ cik: '899689', company: 'Vornado', filing, localPath: 'x.htm', fetchedAt: 'now' });
    expect(e.groundTruth).toBeNull();
    expect(e.groundTruth).not.toEqual({});
  });

  it('carries the source URL so a label can be checked against the filing', () => {
    const e = manifestEntry({ cik: '899689', filing, localPath: 'x.htm', fetchedAt: 'now' });
    expect(e.sourceUrl).toContain('/Archives/edgar/data/899689/');
    expect(e.id).toBe('0000899689-0000899689-24-000012');
  });
});

describe('refusing to score an unlabelled corpus', () => {
  const labelled = { id: 'a', groundTruth: { squareFeet: 1 } };

  it('passes a fully labelled manifest through', () => {
    expect(assertLabelled([labelled])).toHaveLength(1);
  });

  it('counts an empty object as labelled', () => {
    expect(() => assertLabelled([{ id: 'b', groundTruth: {} }])).not.toThrow();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('throws when ground truth is %s, naming the documents', (_label, groundTruth) => {
    expect(() => assertLabelled([labelled, { id: 'unlabelled-1', groundTruth }]))
      .toThrow(/unlabelled-1/);
  });

  it('explains why rather than just refusing', () => {
    // The error has to say what would happen, because the failure it prevents
    // produces a plausible-looking number rather than a crash.
    expect(() => assertLabelled([{ id: 'x', groundTruth: null }]))
      .toThrow(/hallucination/);
  });

  it('truncates the list but says how many there are', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `d-${i}`, groundTruth: null }));
    expect(() => assertLabelled(many)).toThrow(/6 of 6/);
    expect(() => assertLabelled(many)).toThrow(/\.\.\./);
  });
});

describe('SEC access conditions', () => {
  it('declares a client name carrying no personal contact details', () => {
    expect(DEFAULT_USER_AGENT).not.toMatch(/@/);
    expect(DEFAULT_USER_AGENT).toMatch(/credealanalyzer/);
  });
});
