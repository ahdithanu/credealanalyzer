'use strict';

const path = require('node:path');

/**
 * PDF bytes to per-page text, and nothing else.
 *
 * Uses pdfjs-dist (Mozilla's PDF.js), pinned to an exact version in
 * package.json. PDF.js ships as ES modules only, and this package is CommonJS,
 * so it is loaded with a dynamic import() the first time a document arrives
 * rather than at boot: a process that never sees a PDF never pays for it.
 *
 * WHAT THIS DOES NOT DO, ON PURPOSE:
 *   - No OCR. A page with no text layer comes back as '' and the document as
 *     textLayer 'absent'. Text that is not in the file is never invented.
 *   - No rendering. Fonts are not loaded as faces and nothing is drawn, so the
 *     optional canvas dependency is never exercised.
 *   - No script. isEvalSupported is false, which closes the class of bug where
 *     a crafted font turned into evaluated JavaScript (CVE-2024-4367 in older
 *     releases), even though the pinned version is not affected.
 */

/** Refused above this many pages: a 25MB file can declare a page tree far
 *  larger than any offering memo, and each page costs a parse. */
const MAX_PAGES = 2000;

class PdfError extends Error {
  /** @param {'pdf_encrypted'|'pdf_unreadable'|'pdf_too_many_pages'} code */
  constructor(code, message) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
  }
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

const standardFontDataUrl = `${path.join(
  path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}${path.sep}`;

/**
 * Join one page's text items, keeping the line structure.
 *
 * PDF.js marks the item that ends a line with `hasEOL`. Items on one line are
 * concatenated as given (PDF.js already inserts the spaces it can infer), and
 * a line break is written where the document had one. Trailing whitespace on
 * each line is trimmed, so a page that only held spaces reads as empty.
 */
function joinItems(items) {
  let text = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue; // marked-content markers
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return text.split('\n').map((l) => l.replace(/\s+$/u, '')).join('\n').replace(/\n+$/u, '');
}

/**
 * @param {Buffer} bytes  the PDF
 * @returns {Promise<{ pageCount: number, textLayer: 'present'|'absent',
 *   pages: { page: number, text: string }[] }>}
 * @throws {PdfError} encrypted, unreadable or oversized documents
 */
async function extractPages(bytes) {
  const pdfjs = await loadPdfjs();
  // PDF.js may detach the buffer it is given; hand it a copy.
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);

  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl,
    verbosity: 0,
    // Never reach the network for anything a document references.
    disableAutoFetch: true,
    disableStream: true,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    if (err && err.name === 'PasswordException') {
      throw new PdfError('pdf_encrypted', 'the PDF is password protected');
    }
    throw new PdfError('pdf_unreadable', `the PDF could not be read: ${err && err.message}`);
  }

  try {
    if (doc.numPages > MAX_PAGES) {
      throw new PdfError('pdf_too_many_pages', `the PDF has ${doc.numPages} pages; the limit is ${MAX_PAGES}`);
    }
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push({ page: n, text: joinItems(content.items) });
      page.cleanup();
    }
    const textLayer = pages.some((p) => p.text.trim() !== '') ? 'present' : 'absent';
    return { pageCount: doc.numPages, textLayer, pages };
  } catch (err) {
    if (err instanceof PdfError) throw err;
    throw new PdfError('pdf_unreadable', `the PDF could not be read: ${err && err.message}`);
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** The five bytes every PDF starts with. Checked before anything is parsed. */
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const isPdfMagic = (buf) => Buffer.isBuffer(buf) && buf.length >= PDF_MAGIC.length
  && buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);

module.exports = { extractPages, isPdfMagic, joinItems, PdfError, MAX_PAGES };
