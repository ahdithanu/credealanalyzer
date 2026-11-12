/**
 * Filing HTML to the one canonical text that labels, extractors and citations
 * all refer to.
 *
 * A citation is a pair of offsets, and offsets only mean something against a
 * fixed string. If the labeller read one rendering of the filing and the
 * extractor cited offsets into another, groundedness would be measuring the
 * difference between two HTML converters. So there is exactly one converter,
 * it is deterministic, and everything downstream goes through it.
 *
 * The output is deliberately plain:
 *
 *   - one table row per line, non-empty cells joined by " | "
 *   - a cell that is only "%" is glued to the cell before it ("88.9 | %" in the
 *     HTML reads "88.9%"), because filings split the unit into its own column
 *     and a percent with its sign detached is exactly the kind of thing an
 *     extractor misreads as a fraction or a count
 *   - a cell that is only "$" is dropped; it is a typographic column, not a value
 *   - block elements become line breaks; inline XBRL's hidden header is removed
 *
 * Empty cells are dropped, which loses column POSITION. That is a real loss and
 * is not papered over: where a filing's row is short a cell, the text does not
 * say which column a value belonged to, and the labelling rules in
 * docs/extraction-eval.md say how such a value is labelled (it is not).
 *
 * The whole document is one page. `pageText(1)` returns it; any other page
 * number throws, so a citation to a page that does not exist fails verification
 * instead of silently reading page one.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  bull: '•', sect: '§', reg: '®', trade: '™', copy: '©', hellip: '…',
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const hit = ENTITIES[code.toLowerCase()];
    return hit === undefined ? m : hit;
  });
}

const BLOCK = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|table|tbody|thead|hr)\b[^>]*>/gi;

function cleanInline(fragment) {
  return decodeEntities(fragment.replace(BLOCK, ' ').replace(/<[^>]+>/g, ''))
    .replace(/[ \s]+/g, ' ')
    .trim();
}

function rowToLine(rowHtml) {
  const cells = [];
  const re = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = re.exec(rowHtml))) {
    const text = cleanInline(m[1]);
    if (!text || text === '$') continue;
    if ((text === '%' || text === ')' || text === ')%') && cells.length) {
      cells[cells.length - 1] += text;
      continue;
    }
    cells.push(text);
  }
  return cells.join(' | ');
}

/** @param {string} html  a filing's primary document as fetched */
export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<ix:header\b[\s\S]*?<\/ix:header>/gi, '');
  s = s.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // Rows first, so their cells are joined before block tags inside a cell
  // can break them across lines.
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => `\n${rowToLine(row)}\n`);
  s = s.replace(BLOCK, '\n');
  s = decodeEntities(s.replace(/<[^>]+>/g, ''));

  return s
    .split('\n')
    .map((line) => line.replace(/[  \t\r\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * A page reader over one converted document, in the shape scoreDocument wants.
 * Page 1 is the whole document; anything else throws.
 */
export function pageReader(text) {
  return (page) => {
    if (page !== 1) throw new Error(`no page ${page}: a converted filing is a single page`);
    return text;
  };
}
