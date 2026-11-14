'use strict';

/**
 * TEST FIXTURES: minimal PDFs built byte by byte, so the intake tests need no
 * binary files in the repository and every byte of input is visible here.
 *
 * These are synthetic documents made for tests. They are not offering memos,
 * not rent rolls and not ground truth for anything; the strings in them exist
 * only so a test can check that text went in on one page and came out on the
 * same page.
 *
 * The cross-reference table is computed from the real byte offsets, so a
 * strict parser reads these without falling back to repair mode.
 */

/** Escape a string for a PDF literal string `( ... )`. */
const pdfString = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/**
 * Assemble a PDF from numbered object bodies.
 * @param {string[]} objects  object bodies; objects[0] is object 1
 * @param {string} trailerExtra  extra trailer entries (for /Encrypt, /ID)
 */
function assemble(objects, trailerExtra = '') {
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\n`;
  out += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * A PDF whose pages carry a real text layer.
 *
 * @param {string[][]} pages  one array of lines per page; each line is drawn
 *   on its own baseline so the extractor has to produce a line break between
 *   them.
 */
function textPdf(pages) {
  const n = pages.length;
  // 1 catalog, 2 pages tree, 3 font, then (page, content) pairs.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((lines, i) => {
    const contentRef = 5 + i * 2;
    let stream = 'BT\n/F1 12 Tf\n14 TL\n72 720 Td\n';
    lines.forEach((line, j) => {
      if (j > 0) stream += 'T*\n';
      stream += `(${pdfString(line)}) Tj\n`;
    });
    stream += 'ET\n';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  });
  return assemble(objects);
}

/**
 * A PDF with pages but NO text layer: each page only paints a filled
 * rectangle, which is what a scanned page looks like to a text extractor (an
 * image and nothing else). Kept vector rather than an embedded image so the
 * fixture stays a few hundred bytes.
 */
function noTextPdf(pageCount = 2) {
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i++) {
    const stream = '0.5 g\n72 72 468 648 re\nf\n';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  }
  return assemble(objects);
}

/**
 * A PDF protected by the standard security handler with a user password we do
 * not know. The /O and /U entries are arbitrary bytes, so the empty password a
 * reader tries first cannot validate and the reader must ask for a password.
 */
function encryptedPdf() {
  const hex32 = (byte) => `<${byte.repeat(32)}>`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -44 /O ${hex32('AB')} /U ${hex32('CD')} >>`,
  ];
  const id = '<0123456789ABCDEF0123456789ABCDEF>';
  return assemble(objects, `/Encrypt 4 0 R /ID [${id} ${id}] `);
}

/** Starts with the PDF magic and then is nothing a parser can read. */
function corruptPdf() {
  return Buffer.from('%PDF-1.7\nthis is not a pdf body, only its first five bytes\n', 'latin1');
}

module.exports = { textPdf, noTextPdf, encryptedPdf, corruptPdf };
