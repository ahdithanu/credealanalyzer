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
