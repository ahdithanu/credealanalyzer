import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRead, isHeaderLine, splitCells, alignCell, judgeLabel, summarizeReadChecks, readConsistency, READ,
} from '../readCheck';
import { htmlToText, pageReader } from '../text';
import { FIELD_NAMES } from '../schema';

// REAL lines: copied verbatim from htmlToText over the filings in corpus/edgar
// (Vornado, Easterly, Federal Realty, Plymouth, BRT 10-Ks for FY2025). The
// last describe block re-checks that each still appears in the converted
// filing whenever the corpus is on disk.
const VNO_ROSSLYN = [
  'PROPERTY LISTING – CONTINUED',
  'Square Feet',
  'OTHER SEGMENT Property | % Ownership | Type | % Occupancy | In Service | Under Development or Not Available for Lease | Total Property',
  '555 California Street:',
  '555 California Street, San Francisco | 70.0% | Office / Retail | 94.6% | 1,509,000 | — | 1,509,000',
  'Total 555 California Street | 88.9% | 1,820,000 | — | 1,820,000',
  'Our Ownership Interest | 88.9% | 1,274,000 | — | 1,274,000',
  'Other:',
  'Rosslyn Plaza, VA (197 units)(2) | 45.6% | Office / Residential | 22.5% | (3) | 685,000 | 304,000 | 989,000',
];

const DEA_EASTERLY = [
  'The table set forth below shows information relating to the properties we owned, or in which we had an ownership interest, at December 31, 2025, and it includes properties held by the JV:',
  'Property Name | Location | Property Type (1) | Tenant Lease Expiration Year (2) | Leased Square Feet | Annualized Lease Income | Percentage of Total Annualized Lease Income | Annualized Lease Income per Leased Square Foot',
  'Wholly Owned U.S. Government Leased Properties',
  'VA - Loma Linda | Loma Linda, CA | OC | 2036 | 327,614 | 16,933,040 | 4.5% | 51.69',
  'FEMA - Tracy | Tracy, CA | W | 2038 | 210,373 | 4,668,336 | 1.2% | 22.19',
];

const FRT_ITEM2 = [
  'Property, City, State, Zip Code | Year Completed | Year Acquired | Square Feet(1) /Apartment Units | Average Base Rent Per Square Foot(2) | Percentage Leased(3) | Principal Tenant(s)',
  'Tower Shopping Center Springfield, VA 22150 | 1960 | 1998 | 109,000 | $31.09 | 99% | L.A. Mart Total Wine & More Talbots',
];

const PLYM_ITEM2 = [
  'Market | Property (1) | City | State | Property Type | Year Built/ Renovated (2) | Square Footage | Occupancy | Annualized Rent (3) | Percent of Total Annualized Rent (4) | Annualized Rent/ Square Footage (5)',
  'Indianapolis | 2900 Shadeland | Indianapolis | IN | Warehouse/Distribution | 1957/1992 | 933,439 | 80% | 2,255,104 | 1.7% | 3.01',
  '3035 North Shadeland | Indianapolis | IN | Warehouse/Distribution | 1962/2001 & 2004 | 562,497 | 91% | 1,794,542 | 1.4% | 3.52',
];

const BRT_ITEM1 = [
  'Our Percentage Ownership (%) (1) | Average Monthly Rental Rate Per Occupied Unit ($) | Average Physical Occupancy (%)',
  'Property Name and Location | Number of Units | Age | Acquisition Date | 2025 | 2024 | 2023 | 2022 | 2021 | 2025 | 2024 | 2023 | 2022 | 2021',
  'Silvana Oaks Apartments—N. Charleston, SC | 208 | 15 | 10/4/2012 | 100 | 1,576 | 1,539 | 1,486 | 1,370 | 1,231 | 93.9 | 94.4 | 94.7 | 96.0 | 95.1',
];

/** A citation to the `nth` occurrence of `cell` on the line starting `rowStart`. */
function cite(text, rowStart, cell, nth = 0) {
  const lineAt = text.indexOf(rowStart);
  if (lineAt < 0) throw new Error(`fixture has no row ${rowStart}`);
  const lineEnd = text.indexOf('\n', lineAt) < 0 ? text.length : text.indexOf('\n', lineAt);
  let at = lineAt - 1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(cell, at + 1);
    if (at < 0 || at >= lineEnd) throw new Error(`row ${rowStart} has no ${cell} #${nth}`);
  }
  return { page: 1, start: at, end: at + cell.length };
}

describe('the cases the eval recorded as grounded but misread (real lines)', () => {
  const vno = VNO_ROSSLYN.join('\n');
  const dea = DEA_EASTERLY.join('\n');

  it("flags v2's Rosslyn Plaza read: 304,000 sits under 'Under Development', past a footnote cell", () => {
    const r = checkRead(vno, 'squareFeet', cite(vno, 'Rosslyn Plaza', '304,000'));
    expect(r.verdict).toBe(READ.INCONSISTENT);
    expect(r.header).toBe('Under Development or Not Available for Lease');
  });

  it('passes the right Rosslyn read: 989,000 under Total Property, titled Square Feet', () => {
    const r = checkRead(vno, 'squareFeet', cite(vno, 'Rosslyn Plaza', '989,000'));
    expect(r.verdict).toBe(READ.CONSISTENT);
    expect(r.header).toBe('Total Property');
  });

  it("flags Rosslyn's In Service figure as a part when a Total column exists", () => {
    const r = checkRead(vno, 'squareFeet', cite(vno, 'Rosslyn Plaza', '685,000'));
    expect(r.verdict).toBe(READ.INCONSISTENT);
    expect(r.header).toBe('In Service');
  });

  it("passes Rosslyn's occupancy and type, which keep their columns", () => {
    expect(checkRead(vno, 'occupancy', cite(vno, 'Rosslyn Plaza', '22.5%')).verdict).toBe(READ.CONSISTENT);
    expect(checkRead(vno, 'propertyType', cite(vno, 'Rosslyn Plaza', 'Office / Residential')).verdict)
      .toBe(READ.CONSISTENT);
  });

  it('flags the ownership share read as occupancy', () => {
    const r = checkRead(vno, 'occupancy', cite(vno, 'Rosslyn Plaza', '45.6%'));
    expect(r.verdict).toBe(READ.INCONSISTENT);
    expect(r.header).toBe('% Ownership');
  });

  it("flags v1/v2's Easterly read: Leased Square Feet is not size", () => {
    for (const [row, cell] of [['FEMA - Tracy', '210,373'], ['VA - Loma Linda', '327,614']]) {
      const r = checkRead(dea, 'squareFeet', cite(dea, row, cell));
      expect(r.verdict).toBe(READ.INCONSISTENT);
      expect(r.header).toBe('Leased Square Feet');
    }
  });

  it('flags a per-square-foot figure read as size', () => {
    expect(checkRead(dea, 'squareFeet', cite(dea, 'FEMA - Tracy', '22.19')).verdict).toBe(READ.INCONSISTENT);
  });

  it('takes a reader and a page number as score.js does', () => {
    expect(checkRead(pageReader(dea), 'squareFeet', cite(dea, 'FEMA - Tracy', '210,373')).verdict)
      .toBe(READ.INCONSISTENT);
    // A page the reader does not have is not judged.
    expect(checkRead(pageReader(dea), 'squareFeet', { ...cite(dea, 'FEMA - Tracy', '210,373'), page: 2 }).verdict)
      .toBe(READ.INDETERMINATE);
  });
});

describe('correct reads and honest abstentions (real lines)', () => {
  const frt = FRT_ITEM2.join('\n');
  const plym = PLYM_ITEM2.join('\n');
  const brt = BRT_ITEM1.join('\n');

  it("passes Federal Realty's size and year, and flags its acquisition year read as built", () => {
    expect(checkRead(frt, 'squareFeet', cite(frt, 'Tower Shopping', '109,000')).verdict).toBe(READ.CONSISTENT);
    expect(checkRead(frt, 'yearBuilt', cite(frt, 'Tower Shopping', '1960')).verdict).toBe(READ.CONSISTENT);
    const acquired = checkRead(frt, 'yearBuilt', cite(frt, 'Tower Shopping', '1998'));
    expect(acquired.verdict).toBe(READ.INCONSISTENT);
    expect(acquired.header).toBe('Year Acquired');
    // "Percentage Leased" is not occupancy, by the labelling rule.
    expect(checkRead(frt, 'occupancy', cite(frt, 'Tower Shopping', '99%')).verdict).toBe(READ.INCONSISTENT);
  });

  it('passes a Plymouth row whose cell count matches its header', () => {
    expect(checkRead(plym, 'squareFeet', cite(plym, 'Indianapolis | 2900', '933,439')).verdict).toBe(READ.CONSISTENT);
    expect(checkRead(plym, 'occupancy', cite(plym, 'Indianapolis | 2900', '80%')).verdict).toBe(READ.CONSISTENT);
  });

  it('will not guess where a row lost its empty Market cell', () => {
    // Right-aligning would happen to be correct here; nothing in the text says so.
    const r = checkRead(plym, 'squareFeet', cite(plym, '3035 North Shadeland', '562,497'));
    expect(r.verdict).toBe(READ.INDETERMINATE);
    expect(r.reason).toMatch(/dropped empty cell/);
  });

  it("calls 'Year Built/ Renovated' ambiguous, not a match and not a mismatch", () => {
    expect(checkRead(plym, 'yearBuilt', cite(plym, 'Indianapolis | 2900', '1957')).verdict).toBe(READ.INDETERMINATE);
  });

  it("recognises BRT's period header, whose years repeat per group", () => {
    expect(isHeaderLine(splitCells(BRT_ITEM1[1]))).toBe(true);
    // The row has one more cell than that header (the ownership column is
    // headed only on the line above), so its cells are not aligned.
    expect(checkRead(brt, 'occupancy', cite(brt, 'Silvana Oaks', '93.9')).verdict).toBe(READ.INDETERMINATE);
  });

  it('calls a prose citation indeterminate', () => {
    const prose = 'The venture acquired the property for $36,500,000 (including a $24,419,000 mortgage).';
    const at = prose.indexOf('$36,500,000');
    expect(checkRead(prose, 'purchasePrice', { page: 1, start: at, end: at + 11 }).verdict).toBe(READ.INDETERMINATE);
  });
});

describe('constructed cases (CONSTRUCTED fixtures, not from any filing)', () => {
  it('never says consistent for a header that names nothing in the vocabulary', () => {
    const t = 'Asset | Column A | Column B\nFoo Plaza | 12,000 | 7';
    expect(checkRead(t, 'squareFeet', cite(t, 'Foo Plaza', '12,000')).verdict).toBe(READ.INDETERMINATE);
  });

  it('reads "In Service" under a Square Feet title as size when no total sits beside it', () => {
    const t = 'Square Feet\nProperty | In Service\nFoo Plaza | 12,000';
    expect(checkRead(t, 'squareFeet', cite(t, 'Foo Plaza', '12,000')).verdict).toBe(READ.CONSISTENT);
  });

  it('does not read a title as naming a column when the column names another field', () => {
    const t = 'Square Feet\nProperty | % Occupancy | Total\nFoo Plaza | 91.0% | 12,000';
    expect(checkRead(t, 'squareFeet', cite(t, 'Foo Plaza', '91.0%')).verdict).toBe(READ.INCONSISTENT);
  });

  it('refuses a span that is not one cell, or no citation at all', () => {
    const t = 'Property | Square Feet\nFoo Plaza | 12,000';
    const at = t.indexOf('Plaza | 12');
    expect(checkRead(t, 'squareFeet', { page: 1, start: at, end: at + 10 }).verdict).toBe(READ.INDETERMINATE);
    expect(checkRead(t, 'squareFeet', null).verdict).toBe(READ.INDETERMINATE);
    expect(checkRead(t, 'squareFeet', { page: 1, start: 5, end: 9999 }).verdict).toBe(READ.INDETERMINATE);
  });

  it("stops at prose: a table with no header line of its own does not borrow the previous table's", () => {
    const t = 'Property | Square Feet\n'
      + `${'This paragraph is long enough to be prose and not a table title, and it ends the table above. '.repeat(2)}\n`
      + 'Foo Plaza | 12,000';
    expect(checkRead(t, 'squareFeet', cite(t, 'Foo Plaza', '12,000')).verdict).toBe(READ.INDETERMINATE);
  });

  it('skips data rows and section labels on the way up to the header', () => {
    const t = 'Property | Square Feet | Occupancy\nBar Plaza | 9,000 | 88.0%\nWest:\nFoo Plaza | 12,000 | 91.0%';
    expect(checkRead(t, 'squareFeet', cite(t, 'Foo Plaza', '12,000')).verdict).toBe(READ.CONSISTENT);
  });

  it('does not take two unrelated years in a row for a period header', () => {
    expect(isHeaderLine(splitCells('Foo Plaza | 1963 | 2007'))).toBe(false);
    expect(isHeaderLine(splitCells('Property | 2025 | 2024'))).toBe(true);
    expect(isHeaderLine(splitCells('Property | 12,000'))).toBe(false);
  });

  it('realigns past footnote cells only when they account for the whole difference', () => {
    const h = splitCells('Property | A | B | C');
    expect(alignCell(splitCells('Foo | (1) | 1 | 2 | 3'), 3, h)).toEqual({ index: 2 });
    expect(alignCell(splitCells('Foo | (1) | 1 | 2 | 3 | 4'), 3, h).reason).toBeTruthy();
    expect(alignCell(splitCells('Foo | 1 | 2'), 1, h).reason).toBeTruthy();
    expect(alignCell(splitCells('Foo | (1) | 1 | 2 | 3'), 1, h).reason).toMatch(/footnote/);
  });

  it('judges labels by field, with exclusions winning over a compatible term', () => {
    expect(judgeLabel('squareFeet', 'Average Base Rent Per Square Foot').verdict).toBe(READ.INCONSISTENT);
    expect(judgeLabel('squareFeet', 'Rentable Square Feet').verdict).toBe(READ.CONSISTENT);
    expect(judgeLabel('occupancy', 'Percentage Leased').verdict).toBe(READ.INCONSISTENT);
    expect(judgeLabel('occupancy', 'Ownership').verdict).toBe(READ.INCONSISTENT);
    expect(judgeLabel('yearBuilt', 'Date Acquired').verdict).toBe(READ.INCONSISTENT);
    expect(judgeLabel('yearBuilt', 'Year Built or Acquired').verdict).toBe(READ.INDETERMINATE);
    expect(judgeLabel('squareFeet', 'In Service', { siblings: ['Total'] }).verdict).toBe(READ.INCONSISTENT);
    expect(judgeLabel('notAField', 'Square Feet').verdict).toBe(READ.INDETERMINATE);
  });

  it('has a vocabulary for every scored field', () => {
    for (const f of FIELD_NAMES) expect(judgeLabel(f, 'zzz').reason).not.toMatch(/no vocabulary/);
  });
});

describe('summarizing read checks beside outcomes', () => {
  it('counts verdicts and lines flags up with outcomes', () => {
    const s = summarizeReadChecks([
      { verdict: 'inconsistent', outcome: 'error' },
      { verdict: 'inconsistent', outcome: 'hit' },
      { verdict: 'inconsistent', outcome: 'hallucination' },
      { verdict: 'consistent', outcome: 'hit' },
      { verdict: 'indeterminate', outcome: 'error' },
    ]);
    expect(s).toMatchObject({
      answered: 5, consistent: 1, inconsistent: 3, indeterminate: 1, checked: 4,
      flagged: { hit: 1, error: 1, hallucination: 1 }, passed: { hit: 1, error: 0, hallucination: 0 },
      wrongAnswered: 3, wrongFlagged: 2,
    });
    expect(s.inconsistentRate).toBeCloseTo(0.75);
    expect(s.flagPrecision).toBeCloseTo(2 / 3);
    expect(s.wrongRecall).toBeCloseTo(2 / 3);
  });

  it('reports null, not 0, when nothing was checkable or nothing was wrong', () => {
    const s = summarizeReadChecks([{ verdict: 'indeterminate', outcome: 'hit' }]);
    expect(s.inconsistentRate).toBeNull();
    expect(s.flagPrecision).toBeNull();
    expect(s.wrongRecall).toBeNull();
    expect(summarizeReadChecks([]).inconsistentRate).toBeNull();
  });

  it('refuses a verdict it does not know', () => {
    expect(() => summarizeReadChecks([{ verdict: 'fine', outcome: 'hit' }])).toThrow();
  });

  it('checks only answered fields of scored documents, and lists each flag', () => {
    const text = DEA_EASTERLY.join('\n');
    const c = cite(text, 'FEMA - Tracy', '210,373');
    const doc = {
      item: 'dea#FEMA - Tracy',
      predicted: { squareFeet: { value: 210373, quality: 'sourced', citation: c }, address: { value: 'x' } },
      pageText: pageReader(text),
      byField: {
        squareFeet: { outcome: 'hallucination' },
        address: { outcome: 'hallucination' },
        occupancy: { outcome: 'miss' },
        capRate: { outcome: 'correct_abstention' },
      },
    };
    const r = readConsistency([doc]);
    expect(r).toMatchObject({ answered: 2, inconsistent: 1, indeterminate: 1, flagged: { hallucination: 1 } });
    expect(r.flags).toEqual([expect.objectContaining({ item: 'dea#FEMA - Tracy', field: 'squareFeet', header: 'Leased Square Feet' })]);
  });
});

// The fixtures above claim to be verbatim. Hold them to it when the corpus is
// here (it is gitignored; npm run edgar fetches it, and the CI eval job does).
const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../corpus/edgar');
const MANIFEST = join(CORPUS, 'manifest.json');
const haveCorpus = existsSync(MANIFEST)
  && JSON.parse(readFileSync(MANIFEST, 'utf8')).every((e) => e.localPath && existsSync(join(CORPUS, e.localPath)));

describe.skipIf(!haveCorpus)('real fixtures are verbatim lines of the converted filings', () => {
  const texts = haveCorpus
    ? Object.fromEntries(JSON.parse(readFileSync(MANIFEST, 'utf8'))
      .map((e) => [e.localPath, htmlToText(readFileSync(join(CORPUS, e.localPath), 'utf8')).split('\n')]))
    : {};
  const find = (sub) => Object.entries(texts).find(([p]) => p.includes(sub))[1];
  for (const [sub, lines] of [['vno', VNO_ROSSLYN], ['dea', DEA_EASTERLY], ['frt', FRT_ITEM2], ['plym', PLYM_ITEM2], ['brt', BRT_ITEM1]]) {
    it(`${sub}: every fixture line is a whole line of the filing`, () => {
      const have = new Set(find(sub));
      for (const l of lines) expect(have.has(l), l).toBe(true);
    });
  }
});
