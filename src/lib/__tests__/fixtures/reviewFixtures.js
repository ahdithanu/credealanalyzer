/**
 * TEST FIXTURES for document review. Not real documents, not ground truth.
 *
 * The text below is written for these tests and says so in its own first
 * line. It describes no real property. It exists so the review state, the
 * listing mapping and the screen can be exercised against every citation
 * state (grounded, ungrounded, out of range, abstained) without touching the
 * eval corpus.
 */

const PAGE1 = 'FIXTURE DOCUMENT FOR TESTS, NOT A REAL PROPERTY. '
  + 'The subject property at 100 Fixture Way, Testville, OH comprises 12,400 square feet '
  + 'of leasable area and was completed in 1998. The seller is offering it at an asking '
  + 'price that is stated elsewhere.';
const PAGE2 = 'FIXTURE PAGE TWO. As of the fixture date the property is 92% leased.';

export const FIXTURE_DOCUMENT = {
  id: 'fixture-doc-1',
  dealId: 'fixture-deal-1',
  filename: 'fixture-offering-memo.pdf',
  sha256: 'fixture',
  byteSize: 1234,
  pageCount: 2,
  textLayer: 'present',
  pages: [{ page: 1, text: PAGE1 }, { page: 2, text: PAGE2 }],
  createdAt: '2026-11-01T00:00:00Z',
};

export const FIXTURE_SCANNED = {
  ...FIXTURE_DOCUMENT,
  id: 'fixture-doc-scanned',
  filename: 'fixture-scanned.pdf',
  textLayer: 'absent',
  pages: [],
};

function cite(page, text, quote) {
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`fixture quote not in page: ${quote}`);
  return { page, start, end: start + quote.length };
}

/** C2 predictions over FIXTURE_DOCUMENT, one per citation state. */
export function fixturePredictions() {
  return {
    // grounded, page 1
    address: {
      value: '100 Fixture Way, Testville, OH', quality: 'sourced', confidence: 0.9,
      citation: cite(1, PAGE1, '100 Fixture Way, Testville, OH'),
    },
    squareFeet: {
      value: 12400, quality: 'sourced', confidence: 0.8,
      citation: cite(1, PAGE1, '12,400 square feet'),
    },
    // ungrounded: the quote was not found
    purchasePrice: { value: 2400000, quality: 'sourced', confidence: 0.4, citation: null },
    // a citation pointing past the end of the page text
    yearBuilt: {
      value: 1998, quality: 'sourced', confidence: null,
      citation: { page: 1, start: PAGE1.length - 2, end: PAGE1.length + 40 },
    },
    // grounded, page 2
    occupancy: {
      value: 92, quality: 'sourced', confidence: 0.7,
      citation: cite(2, PAGE2, '92% leased'),
    },
    // propertyType, netOperatingIncome, capRate: abstained (absent)
  };
}

export const FIXTURE_PAGES = { PAGE1, PAGE2 };

/** A draft field with no eval behind it, as PRODUCT_FIELDS will carry. */
export const FIXTURE_DRAFT_FIELD = {
  name: 'askingRent', kind: 'money', label: 'Asking rent', unit: '$/SF/yr', measured: false,
};
