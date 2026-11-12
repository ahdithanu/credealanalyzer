import { describe, it, expect } from 'vitest';
import { extractFromFiling } from '../tableReader';
import { citationSupports } from '../score';
import { pageReader } from '../text';

// Short verbatim excerpts of the converted filings in corpus/edgar, so the
// tests exercise the shapes the extractor meets without needing the corpus.
const VNO = [
  'NEW YORK SEGMENT Property | % Ownership | Type | % Occupancy | In Service | Under Development or Not Available for Lease | Total Property',
  '1290 Avenue of the Americas | 70.0% | Office / Retail | 91.3% | 2,089,000 | — | 2,089,000',
  '100 West 33rd Street | 100.0% | Office / Retail | 87.4% | 858,000 | 257,000 | 1,115,000',
  'Hotel Pennsylvania site (PENN 15) | 100.0% | Land | (5) | — | — | —',
  '606 Broadway | 50.0% | Office / Retail | 24.8% | 36,000 | — | 36,000',
  'Encumbrances(1) | Initial cost to company | Costs capitalized subsequent to acquisition | Gross amount at which carried at close of period | Accumulated depreciation and amortization | Date of construction(3) | Date acquired | Life on which depreciation in latest income statement is computed',
  '| Land | Buildings and improvements | Land | Buildings and improvements | Total(2)',
  '1290 Avenue of the Americas | 950,000 | 518,244 | 926,992 | 370,950 | 518,244 | 1,297,942 | 1,816,186 | 553,859 | 1963 | 2007 | (4)',
  '606 Broadway | 74,494 | 45,406 | 8,993 | 486 | 23,930 | 30,955 | 54,885 | 3,936 | 2016 | (4)',
].join('\n');

const PLYM = [
  'Market | Property (1) | City | State | Property Type | Year Built/ Renovated (2) | Square Footage | Occupancy | Annualized Rent (3) | Percent of Total Annualized Rent (4) | Annualized Rent/ Square Footage (5)',
  'Memphis | 1590-1680 Century Center Parkway | Memphis | TN | Warehouse/Distribution | 1990-2004 | 520,052 | 95% | 4,949,938 | 3.8% | 10.06',
  '6290 Shelby View Drive | Memphis | TN | Warehouse/Distribution | 1999/2003 | 74,665 | 100% | 454,357 | 0.3% | 6.09',
  'Metro Area | Address | Encumbrances | Land | Building and Improvements | Costs Capitalized Subsequent to Acquisition | Land | Building and Improvements | Total (2) | Accumulated Depreciation (3) | Year Acquired | Year Built/ Renovated (4) | Depreciable Life (in years) (5)',
  'Indianapolis, IN | 6575 East 30th Street | 566 | 1,408 | 32 | 566 | 1,440 | 2,006 | 548 | 2019 | 1998 | 19',
].join('\n');

const FRT = [
  'Property, City, State, Zip Code | Year Completed | Year Acquired | Square Feet(1) /Apartment Units | Average Base Rent Per Square Foot(2) | Percentage Leased(3) | Principal Tenant(s)',
  'Tower Shopping Center Springfield, VA 22150 | 1960 | 1998 | 109,000 | $31.09 | 99% | L.A. Mart Total Wine & More Talbots',
  'Descriptions | Encumbrance | Initial cost to company | Cost Capitalized Subsequent to Acquisition | Gross amount at which carried at close of period | Accumulated Depreciation and Amortization | Date of Construction | Date Acquired | Life on which depreciation in latest income statements is computed',
  'TOWER SHOPPING CENTER (Virginia) | 7,170 | 10,518 | 12,513 | 7,292 | 22,909 | 30,201 | 13,394 | 1953-1960 | 8/24/1998 | (1)',
].join('\n');

const BRT = [
  'Property Name and Location | Number of Units | Age | Acquisition Date | 2025 | 2024',
  'Avalon Apartments—Pensacola, FL | 276 | 17 | 12/22/2014 | 100 | 1,449 | 94.2',
  'Civic Center I—Southaven, MS | 392 | 23 | 2/29/2016 | 100 | 1,304 | 96.6',
  'Civic Center II — Southaven, MS | 384 | 20 | 9/1/2016 | 100 | 1,376 | 95.6',
  'Description | Encumbrances | Land | Buildings and Improvements | Land | Improvements | Land | Buildings and Improvements | Total (a) | Accumulated Depreciation | Date of Construction | Date Acquired',
  'Pensacola, FL | — | 2,758 | 25,192 | — | 2,756 | 2,758 | 27,948 | 30,706 | 10,638 | 2008 | Dec-2014 | 30 years',
  'Southaven, MS | 44,785 | 3,646 | 45,535 | — | 2,415 | 3,646 | 47,950 | 51,596 | 6,861 | 2003 | July-2022 | 30 years',
  'Southaven, MS | 28,087 | 3,847 | 46,433 | — | 2,476 | 3,847 | 48,909 | 52,756 | 7,073 | 2006 | July-2022 | 30 years',
].join('\n');

const values = (out) => Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.value]));

describe('tableReader on a property listing', () => {
  it('reads type, occupancy, total square feet, address and construction year', () => {
    expect(values(extractFromFiling(VNO, '1290 Avenue of the Americas'))).toEqual({
      address: '1290 Avenue of the Americas',
      propertyType: 'mixed-use',
      occupancy: 91.3,
      squareFeet: 2_089_000,
      yearBuilt: 1963,
    });
  });

  it('takes Total Property over In Service square feet', () => {
    expect(extractFromFiling(VNO, '100 West 33rd Street').squareFeet.value).toBe(1_115_000);
  });

  it('abstains where the cell says nothing: "(5)" occupancy, "—" square feet, no street address', () => {
    const out = values(extractFromFiling(VNO, 'Hotel Pennsylvania site (PENN 15)'));
    expect(out).toEqual({ propertyType: 'other' });
  });

  it('abstains on a construction year when a Schedule III row carries one date where the header has two', () => {
    // Rendered, 606 Broadway's lone 2016 sits under Date acquired. The text
    // cannot say so; reading it as yearBuilt would be an invented fact.
    expect(extractFromFiling(VNO, '606 Broadway').yearBuilt).toBeUndefined();
  });

  it('cites cells whose text holds the value, so every answer is checkably grounded', () => {
    const out = extractFromFiling(VNO, '1290 Avenue of the Americas');
    for (const [field, a] of Object.entries(out)) {
      expect(citationSupports(a.citation, a.value, pageReader(VNO), field)).toBe(true);
    }
  });
});

describe('tableReader on other table shapes', () => {
  it('aligns from the property column when the market cell is present or absent', () => {
    expect(values(extractFromFiling(PLYM, '1590-1680 Century Center Parkway'))).toMatchObject({
      address: '1590-1680 Century Center Parkway', propertyType: 'industrial', squareFeet: 520_052, occupancy: 95,
    });
    expect(values(extractFromFiling(PLYM, '6290 Shelby View Drive'))).toMatchObject({
      address: '6290 Shelby View Drive', squareFeet: 74_665, occupancy: 100, yearBuilt: 1999,
    });
  });

  it('abstains on a year range', () => {
    expect(extractFromFiling(PLYM, '1590-1680 Century Center Parkway').yearBuilt).toBeUndefined();
  });

  it('reads Schedule III dates in the order its header states (acquired-then-built here)', () => {
    expect(extractFromFiling(PLYM, '6575 East 30th Street').yearBuilt.value).toBe(1998);
  });

  it('never reads Percentage Leased as occupancy', () => {
    expect(extractFromFiling(FRT, 'Tower Shopping Center Springfield, VA 22150').occupancy).toBeUndefined();
  });

  it('never reads a header that names occupancy and leasing together as occupancy', () => {
    // Constructed header, not from the corpus: OMs and some filings print
    // "Leased Occupancy", which counts signed-not-commenced space. The guard
    // exists for that phrasing; this is the only way to exercise it.
    const doc = [
      'Property | Type | Leased Occupancy | Square Feet',
      '10 Main Street | Office | 97% | 50,000',
    ].join('\n');
    const out = extractFromFiling(doc, '10 Main Street');
    expect(out.squareFeet.value).toBe(50_000);
    expect(out.occupancy).toBeUndefined();
  });

  it('prefers the property table over Schedule III when they disagree', () => {
    // Item 2 says 1960; Schedule III says 1953-1960. Primary table wins.
    expect(extractFromFiling(FRT, 'Tower Shopping Center Springfield, VA 22150').yearBuilt.value).toBe(1960);
  });

  it('keeps the first statement when a later table states a different single year', () => {
    // Constructed: no property in the corpus has two conflicting SINGLE years
    // (Tower Shopping Center's Schedule III gives a range, which is abstained
    // on anyway), so the ordering rule needs its own fixture to be tested.
    const doc = [
      'Property | Type | Year Built | Square Feet',
      '10 Main Street | Office | 1960 | 50,000',
      'Description | Encumbrances | Land | Total | Accumulated Depreciation | Date of Construction | Date Acquired',
      '10 Main Street | 1,000 | 2,000 | 3,000 | 4,000 | 1953 | 1998',
    ].join('\n');
    expect(extractFromFiling(doc, '10 Main Street').yearBuilt.value).toBe(1960);
  });

  it('joins a location-only Schedule III row only when the location is unique', () => {
    expect(extractFromFiling(BRT, 'Avalon Apartments—Pensacola, FL').yearBuilt.value).toBe(2008);
    // Two Southaven rows, two Southaven properties: which is which is not the
    // reader's to guess.
    expect(extractFromFiling(BRT, 'Civic Center I—Southaven, MS').yearBuilt).toBeUndefined();
  });

  it('returns nothing for a subject the filing does not contain', () => {
    expect(extractFromFiling(VNO, '1 Main Street')).toEqual({});
  });
});

// ---- v2: each test below is one defect the v1 holdout found ----

const BRT_FULL = [
  'Our Multi-Family Properties',
  'Generally, our multi-family properties are garden apartments and, to a lesser extent, mid-rise or town home style properties.',
  'Our Percentage Ownership (%) (1) | Average Monthly Rental Rate Per Occupied Unit ($) | Average Physical Occupancy (%)',
  'Property Name and Location | Number of Units | Age | Acquisition Date | 2025 | 2024 | 2023 | 2022 | 2021 | 2025 | 2024 | 2023 | 2022 | 2021',
  'Avalon Apartments—Pensacola, FL | 276 | 17 | 12/22/2014 | 100 | 1,449 | 1,498 | 1,518 | 1,438 | 1,250 | 94.2 | 94.8 | 95.0 | 96.3 | 98.1',
  '1322 North —Auburn, AL | 214 | 23 | 7/15/2025 | 80 | 1,262 | — | — | — | — | 87.7 | — | — | — | —',
  'On July 15, 2025, an unconsolidated joint venture in which the Company has an 80% interest, acquired 1322 North, a 214 unit multi-family property located in Auburn, AL (the "Auburn Acquisition"). The venture acquired the property for $36,500,000 (including a $24,419,000 mortgage). The mortgage matures in 2032.',
].join('\n');

describe('tableReader v2', () => {
  it('does not take a data row of small numbers for a header', () => {
    // v1 read "6701 East 30th Street | 334 | 428 | 2 | ..." as a header, never
    // saw "Year Acquired", and missed Outland Center's construction year.
    const doc = [
      'Metro Area | Address | Encumbrances | Land | Building and Improvements | Costs Capitalized Subsequent to Acquisition | Land | Building and Improvements | Total (2) | Accumulated Depreciation (3) | Year Acquired | Year Built/ Renovated (4) | Depreciable Life (in years) (5)',
      'Indianapolis, IN | 6555 East 30th Street | 1,881 | 6,636 | 635 | 1,881 | 7,271 | 9,152 | 2,927 | 2019 | 1969/1997 | 17',
      'Indianapolis, IN | 6701 East 30th Street | 334 | 428 | 2 | 334 | 430 | 764 | 290 | 2019 | 1990 | 17',
      'Memphis, TN | Outland Center Memphis I | -(1) | 678 | 9,227 | 1,138 | 678 | 10,365 | 11,043 | 1,523 | 2022 | 1988 | 21-25',
    ].join('\n');
    expect(extractFromFiling(doc, 'Outland Center Memphis I').yearBuilt.value).toBe(1988);
  });

  it('does not read a numbered property name as a street address', () => {
    // v1's holdout hallucination: grounded, confident, and wrong.
    expect(extractFromFiling(BRT_FULL, '1322 North —Auburn, AL').address).toBeUndefined();
    // A real numbered street address still reads.
    expect(extractFromFiling(VNO, '606 Broadway').address.value).toBe('606 Broadway');
  });

  it('reads occupancy under a spanning label over grouped year columns, newest year', () => {
    const out = extractFromFiling(BRT_FULL, 'Avalon Apartments—Pensacola, FL');
    expect(out.occupancy.value).toBe(94.2);
    expect(extractFromFiling(BRT_FULL, '1322 North —Auburn, AL').occupancy.value).toBe(87.7);
    expect(citationSupports(out.occupancy.citation, 94.2, pageReader(BRT_FULL), 'occupancy')).toBe(true);
  });

  it('takes a type from a heading that names one category', () => {
    const out = extractFromFiling(BRT_FULL, '1322 North —Auburn, AL');
    expect(out.propertyType.value).toBe('multifamily');
    expect(citationSupports(out.propertyType.citation, 'multifamily', pageReader(BRT_FULL), 'propertyType')).toBe(true);
  });

  it('takes no type from a heading that names two categories', () => {
    // "Retail and Residential Properties" heads a table holding both kinds;
    // it does not say any row is mixed-use.
    const doc = [
      'Retail and Residential Properties',
      'Property, City, State, Zip Code | Year Completed | Year Acquired | Square Feet(1) /Apartment Units | Average Base Rent Per Square Foot(2) | Percentage Leased(3) | Principal Tenant(s)',
      'Westpost Arlington, VA 22202 | 2001-2002 | 1998/2010 | 298,000 | $35.22 | 99% | Harris Teeter Target TJ Maxx Ulta Walgreens DSW',
    ].join('\n');
    const out = extractFromFiling(doc, 'Westpost Arlington, VA 22202');
    expect(out.squareFeet.value).toBe(298_000); // the row was found
    expect(out.propertyType).toBeUndefined();
  });

  it('reads a purchase price stated in prose about the subject, with a grounded citation', () => {
    const out = extractFromFiling(BRT_FULL, '1322 North —Auburn, AL');
    expect(out.purchasePrice.value).toBe(36_500_000);
    expect(citationSupports(out.purchasePrice.citation, 36_500_000, pageReader(BRT_FULL), 'purchasePrice')).toBe(true);
  });

  it('never reads a portfolio price as a property price', () => {
    const doc = 'During 2025, we acquired properties for $752.8 million, and will continue to evaluate additional opportunities in 2026.';
    expect(extractFromFiling(doc, 'Del Monte Shopping Center Monterey, CA 93940')).toEqual({});
    const named = 'We acquired Del Monte Shopping Center and two other properties for $300.0 million.';
    expect(extractFromFiling(named, 'Del Monte Shopping Center Monterey, CA 93940').purchasePrice).toBeUndefined();
  });

  it('scales a prose price and still grounds it', () => {
    // Constructed: no single-property "million" price exists in the corpus.
    const doc = 'In February 2025 we acquired Del Monte Shopping Center for $123.5 million.';
    const out = extractFromFiling(doc, 'Del Monte Shopping Center Monterey, CA 93940');
    expect(out.purchasePrice.value).toBe(123_500_000);
    expect(citationSupports(out.purchasePrice.citation, 123_500_000, pageReader(doc), 'purchasePrice')).toBe(true);
  });
});

describe('tableReader v2: prose names', () => {
  it('does not take a price stated for a longer name containing the subject', () => {
    // Constructed. "Town Center" is a prefix candidate for the subject below,
    // and must not match inside "Annapolis Town Center".
    const doc = 'In October 2025 we acquired Annapolis Town Center for $187.0 million.';
    expect(extractFromFiling(doc, 'Town Center Plaza Leawood, KS 66209').purchasePrice).toBeUndefined();
  });
});

// ---- v3: the v2 holdout2 error, plus generic robustness for unseen layouts ----

const VNO_HEADER = 'OTHER SEGMENT Property | % Ownership | Type | % Occupancy | In Service | Under Development or Not Available for Lease | Total Property';

describe('tableReader v3', () => {
  it('drops a footnote cell that makes a row longer than its header', () => {
    // v2 read 304,000 (under development) as Rosslyn Plaza's total.
    const doc = [VNO_HEADER,
      'Rosslyn Plaza, VA (197 units)(2) | 45.6% | Office / Residential | 22.5% | (3) | 685,000 | 304,000 | 989,000'].join('\n');
    const out = extractFromFiling(doc, 'Rosslyn Plaza, VA (197 units)');
    expect(out.squareFeet.value).toBe(989_000);
    expect(out.occupancy.value).toBe(22.5);
    expect(citationSupports(out.squareFeet.citation, 989_000, pageReader(doc), 'squareFeet')).toBe(true);
  });

  it('keeps a footnote cell that stands in for a value when the row is not too long', () => {
    // "(5)" in the occupancy column means "under development"; dropping it
    // would shift 383,000 out of the Total Property column.
    const doc = [VNO_HEADER, '623 Fifth Avenue | 100.0% | Office | (5) | — | 383,000 | 383,000'].join('\n');
    const out = extractFromFiling(doc, '623 Fifth Avenue');
    expect(out.squareFeet.value).toBe(383_000);
    expect(out.occupancy).toBeUndefined();
  });

  it('reads Schedule III through an unambiguous shorter name, with or without spaces round a slash', () => {
    const doc = [
      'Property, City, State, Zip Code | Year Completed | Year Acquired | Square Feet(1) /Apartment Units | Average Base Rent Per Square Foot(2) | Percentage Leased(3) | Principal Tenant(s)',
      'Plaza El Segundo / The Point El Segundo, CA 90245 (6) | 2006-2007, 2016 | 2011/2013 | 503,000 | $49.24 | 99% | Whole Foods Nordstrom Rack HomeGoods',
      'Descriptions | Encumbrance | Initial cost to company | Cost Capitalized Subsequent to Acquisition | Gross amount at which carried at close of period | Accumulated Depreciation and Amortization | Date of Construction | Date Acquired | Life on which depreciation in latest income statements is computed',
      'PLAZA EL SEGUNDO/THE POINT (California) | 124,891 | 62,127 | 153,556 | 95,586 | 64,463 | 246,806 | 311,269 | 100,720 | 2006/2007/ 2016 | 12/30/11, 6/14/13, 7/26/13, & 12/27/13 | (1)',
    ].join('\n');
    expect(extractFromFiling(doc, 'Plaza El Segundo / The Point El Segundo, CA 90245').yearBuilt.value).toBe(2006);
  });

  it('refuses a shorter name that starts more than one property\'s row', () => {
    // Constructed years: in the filing both Santana Row years are ranges, so
    // the real lines cannot show the guard mattering. "Santana Row" starts the
    // rows of two properties; the residential one must not take the
    // commercial Schedule III row's year.
    const doc = [
      'Property, City, State, Zip Code | Year Completed | Year Acquired | Square Feet(1) /Apartment Units | Average Base Rent Per Square Foot(2) | Percentage Leased(3) | Principal Tenant(s)',
      'Santana Row San Jose, CA 95128 | 2002 | 1997 | 1,521,000 | $57.21 | 98% | Crate & Barrel',
      'Santana Row Residential San Jose, CA 95128 | 2003-2006, 2014 | 1997/2012 | 554 units | N/A | 97%',
      'Descriptions | Encumbrance | Initial cost to company | Cost Capitalized Subsequent to Acquisition | Gross amount at which carried at close of period | Accumulated Depreciation and Amortization | Date of Construction | Date Acquired | Life on which depreciation in latest income statements is computed',
      'SANTANA ROW (California) | 65,930 | 7,502 | 1,315,096 | 56,840 | 1,331,688 | 1,388,528 | 364,278 | 1999 | 3/5/97 | (1)',
    ].join('\n');
    expect(extractFromFiling(doc, 'Santana Row Residential San Jose, CA 95128').yearBuilt).toBeUndefined();
  });

  it('reads common header synonyms, and does not mistake "Rentable" for rent', () => {
    // Constructed header in the vocabulary other REITs use.
    const doc = [
      'Building Name | Asset Type | Year Constructed | Rentable Square Feet | % Occupied | Annualized Rent per Leased Square Foot',
      '100 Main Street | Office | 1985 | 120,500 | 91.0% | 32.10',
    ].join('\n');
    expect(values(extractFromFiling(doc, '100 Main Street'))).toEqual({
      address: '100 Main Street', propertyType: 'office', yearBuilt: 1985, squareFeet: 120_500, occupancy: 91,
    });
  });
});
