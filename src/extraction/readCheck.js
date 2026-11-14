/**
 * Read consistency: does a cited table cell sit under a header that names the
 * field it was cited for?
 *
 * Groundedness (score.js `citationSupports`) checks a pointer: the span holds
 * the value. It cannot tell a right cell from a wrong cell that happens to hold
 * the value it was read as. Across three holdouts every wrong answer carried a
 * grounded citation (docs/extraction-eval.md): Rosslyn Plaza's square feet read
 * from "Under Development or Not Available for Lease", Easterly's sizes read
 * from "Leased Square Feet". This module checks the other half, the reading: it
 * finds the cell the citation points into, finds the column header above it,
 * and judges the header's label against a per-field vocabulary.
 *
 * It answers one of three things and is built to prefer the third:
 *
 *   'consistent'    the aligned header names the field (a compatible term
 *                   matched and nothing incompatible did)
 *   'inconsistent'  the aligned header names something else: a qualifier the
 *                   field excludes ("leased", "under development"), a ratio
 *                   ("per square foot"), or another field's quantity
 *   'indeterminate' anything this cannot decide: a prose citation, a span that
 *                   is not one cell, no header found, a row whose cell count
 *                   does not match its header (text.js drops empty cells, so
 *                   position is lost), or a header that names neither
 *
 * There is no default to 'consistent'. A check that passes what it did not
 * look at is the failure this repository keeps writing down.
 *
 * The vocabulary is written per FIELD, from what the field means, never per
 * filing or per item. docs/read-check.md records which corpus cases it catches
 * and which it misses; a miss is reported there, not tuned away here.
 *
 * Input is the canonical text of one page (src/extraction/text.js format: one
 * table row per line, non-empty cells joined by " | "), or a reader
 * `(page) => text` such as text.js `pageReader`, and a citation
 * `{ page, start, end }` whose offsets index into that page's text.
 */

export const READ = {
  CONSISTENT: 'consistent',
  INCONSISTENT: 'inconsistent',
  INDETERMINATE: 'indeterminate',
};

const SEP = ' | ';

/**
 * Per-field header vocabulary.
 *
 *   compatible    a header term that names this field
 *   excluded      a header term under which this field can never sit, whatever
 *                 else the label says (a ratio, a share, another quantity)
 *   incompatible  a qualifier that makes the column something other than this
 *                 field ("Leased Square Feet" is not size). Overridden only
 *                 when the label offers it as an ALTERNATIVE beside a
 *                 compatible term ("Year Built/Acquired"), which is ambiguous
 *   whenTotal     incompatible only when another column of the same header is
 *                 a total ("In Service" is a part when "Total" sits beside it)
 */
export const VOCABULARY = {
  address: {
    compatible: [/\baddress\b/i, /\bstreet\b/i],
    excluded: [/\bcity\b/i, /\bstate\b/i, /\bzip\b/i, /\bmsa\b/i, /\bsubmarket\b/i, /\btenants?\b/i],
    incompatible: [],
  },
  propertyType: {
    compatible: [/\btype\b/i, /\buse\b/i, /\bcategory\b/i],
    excluded: [/\btenants?\b/i, /\bcity\b/i, /\bstate\b/i],
    incompatible: [],
  },
  squareFeet: {
    compatible: [/\bsquare\s*f(?:ee|oo)t/i, /\bsq\.?\s*ft\b/i, /\bgla\b/i, /\bgross leasable\b/i, /\brentable area\b/i],
    excluded: [/\bper\b/i, /\/\s*(?:square|sq\.?\s*f)/i, /\brent\b/i, /\bincome\b/i, /%|\bpercent/i, /\bownership\b/i],
    incompatible: [/\bunder development\b/i, /\bnot available\b/i, /\bleased\b/i, /\bvacant\b/i, /\bavailable for lease\b/i],
    whenTotal: [/\bin[- ]service\b/i],
  },
  yearBuilt: {
    compatible: [/\bbuilt\b/i, /\bconstruct(?:ed|ion)\b/i, /\bcompleted\b/i, /\bcompletion\b/i],
    excluded: [/\bexpir/i, /\blease\b/i, /\bage\b/i],
    incompatible: [/\bacquir/i, /\bacquisition\b/i, /\bpurchased?\b/i, /\brenovat/i, /\bredevelop/i],
  },
  purchasePrice: {
    compatible: [/\bprice\b/i, /\bpurchase\b/i, /\bconsideration\b/i],
    excluded: [/\bencumbrance/i, /\bdepreciation\b/i, /\bcarried\b/i, /\bmortgage\b/i, /\bdebt\b/i, /\bloan\b/i, /\bper\b/i],
    incompatible: [/\binitial cost\b/i],
  },
  netOperatingIncome: {
    compatible: [/\bnet operating income\b/i, /\bnoi\b/i],
    excluded: [/\bper\b/i, /%|\bpercent/i],
    incompatible: [/\bannualized\b/i, /\bbase rent\b/i, /\brevenue\b/i, /\bgross\b/i],
  },
  capRate: {
    compatible: [/\bcap(?:italization)?\.?\s*rate\b/i],
    excluded: [/\binterest rate\b/i, /\bdiscount\b/i, /\bownership\b/i],
    incompatible: [/\byield on cost\b/i],
  },
  occupancy: {
    compatible: [/\boccupan/i, /\boccupied\b/i],
    excluded: [/\brent\b/i, /\bper\b/i, /\bownership\b/i, /\bincome\b/i, /\bexpir/i],
    incompatible: [/\bleased\b/i, /\blease\b/i],
  },
};

const TOTAL = /\btotal\b/i;
// A label offering alternatives: "Year Built/ Renovated", "Built or Acquired".
const ALTERNATIVE = /\s*\/\s*|\s+or\s+/i;

// A cell that is a value rather than a label: amounts, percents, dates, year
// ranges, nil dashes, footnote markers. Labels carry letters.
const VALUE = /^[\d\s,.$%()\-\u2013\u2014/&]+$/;
const BARE_YEAR = /^(?:19|20)\d{2}$/;
const FOOTNOTE = /^\(\d{1,2}\)$/;
// A single-cell line this long is prose, so the table has ended.
const PROSE_LENGTH = 100;
// How far above the cited row a header is looked for.
const MAX_SCAN = 400;

/** Split one canonical line into cells with their offsets in the line. */
export function splitCells(line) {
  const cells = [];
  let at = 0;
  for (const text of line.split(SEP)) {
    cells.push({ text, start: at, end: at + text.length });
    at += text.length + SEP.length;
  }
  return cells;
}

const isValue = (t) => VALUE.test(t.trim()) && /[\d\-\u2013\u2014]/.test(t);

/**
 * A header line names columns and carries no data values. Bare years are
 * allowed only as a run of consecutive years ("2025 | 2024 | 2023"), which is
 * how a filing heads its period columns; two unrelated years in a row
 * ("1963 | 2007") are data.
 */
export function isHeaderLine(cells) {
  if (cells.length < 2) return false;
  if (!cells.some((c) => /[A-Za-z]/.test(c.text))) return false;
  const years = [];
  for (const c of cells) {
    const t = c.text.trim();
    if (BARE_YEAR.test(t)) { years.push(Number(t)); continue; }
    if (isValue(t)) return false;
  }
  if (years.length === 0) return true;
  // Every year must belong to a run of at least two consecutive years; a
  // header may repeat its run per group ("2025 | 2024 | 2025 | 2024").
  return years.every((y, i) => Math.abs(y - years[i - 1]) === 1 || Math.abs(years[i + 1] - y) === 1);
}

/** Locate the line and cell a span falls in, or say why it does not. */
export function locateCell(text, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) {
    return { reason: 'span out of range' };
  }
  const span = text.slice(start, end);
  if (span.includes('\n')) return { reason: 'span crosses a line' };
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', start);
  if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const cells = splitCells(line);
  if (cells.length < 2) return { reason: 'prose: the cited line is not a table row' };
  const s = start - lineStart;
  const e = end - lineStart;
  const cellIndex = cells.findIndex((c) => c.start <= s && e <= c.end);
  if (cellIndex < 0) return { reason: 'span is not inside one cell' };
  const lineIndex = text.slice(0, lineStart).split('\n').length - 1;
  return { lineIndex, cells, cellIndex };
}

/**
 * The nearest header line above a row, plus the one-cell title lines directly
 * above that header ("Square Feet" over "In Service | ... | Total Property"),
 * which are context only: a spanned title cannot be aligned to a column.
 */
export function findHeader(lines, lineIndex) {
  for (let j = lineIndex - 1; j >= 0 && j >= lineIndex - MAX_SCAN; j--) {
    const cells = splitCells(lines[j]);
    if (cells.length >= 2) {
      if (isHeaderLine(cells)) {
        const titles = [];
        for (let k = j - 1; k >= 0 && titles.length < 2; k--) {
          const above = splitCells(lines[k]);
          if (above.length !== 1) break;
          const t = above[0].text.trim();
          if (t.length >= PROSE_LENGTH || isValue(t)) break;
          titles.push(t);
        }
        return { lineIndex: j, cells, titles };
      }
      continue; // another data row of the same table
    }
    if (lines[j].trim().length >= PROSE_LENGTH) return { reason: 'no header: prose before any header line' };
    // short single-cell lines inside a table: section labels, page numbers, rules
  }
  return { reason: 'no header line found' };
}

/**
 * The header column a row cell belongs to, or why that cannot be said.
 *
 * Equal cell counts align by position. A row LONGER than its header is
 * realigned only by dropping standalone footnote markers ("(3)"), and only when
 * dropping all of them makes the counts equal exactly. A row SHORTER than its
 * header has lost an empty cell somewhere and is never guessed at.
 */
export function alignCell(rowCells, cellIndex, headerCells) {
  const n = rowCells.length;
  const m = headerCells.length;
  if (n === m) return { index: cellIndex };
  if (n < m) return { reason: `row has ${n} cells, header ${m}: a dropped empty cell makes position ambiguous` };
  if (FOOTNOTE.test(rowCells[cellIndex].text.trim())) return { reason: 'the cited cell is a footnote marker' };
  const kept = rowCells.map((c, i) => i).filter((i) => !FOOTNOTE.test(rowCells[i].text.trim()));
  if (kept.length !== m) {
    return { reason: `row has ${n} cells, header ${m}, and footnote markers do not account for the difference` };
  }
  return { index: kept.indexOf(cellIndex) };
}

const matches = (patterns = [], label) => patterns.find((re) => re.test(label)) || null;

/**
 * Judge one header label for one field.
 * @param {string} field
 * @param {string} label  the aligned column header
 * @param {{ siblings?: string[], titles?: string[] }} [context]
 *   siblings: the other column labels of the same header line
 *   titles:   one-cell title lines above the header, consulted only when the
 *             column label itself names nothing
 * @returns {{verdict:string, reason:string}}
 */
export function judgeLabel(field, label, { siblings = [], titles = [] } = {}) {
  const v = VOCABULARY[field];
  if (!v) return { verdict: READ.INDETERMINATE, reason: `no vocabulary for field ${field}` };

  const excluded = matches(v.excluded, label);
  if (excluded) return { verdict: READ.INCONSISTENT, reason: `header "${label}" excludes ${field} (${excluded})` };

  let incompatible = matches(v.incompatible, label);
  if (!incompatible && v.whenTotal && siblings.some((s) => TOTAL.test(s))) incompatible = matches(v.whenTotal, label);
  const compatible = matches(v.compatible, label);

  if (incompatible && compatible) {
    const parts = label.split(ALTERNATIVE).filter(Boolean);
    const onlyCompatible = parts.some((p) => matches(v.compatible, p) && !matches(v.incompatible, p));
    const onlyIncompatible = parts.some((p) => !matches(v.compatible, p) && matches(v.incompatible, p));
    if (parts.length > 1 && onlyCompatible && onlyIncompatible) {
      return { verdict: READ.INDETERMINATE, reason: `header "${label}" names ${field} as one of alternatives` };
    }
  }
  if (incompatible) return { verdict: READ.INCONSISTENT, reason: `header "${label}" is not ${field} (${incompatible})` };
  if (compatible) return { verdict: READ.CONSISTENT, reason: `header "${label}" names ${field} (${compatible})` };

  for (const [other, ov] of Object.entries(VOCABULARY)) {
    if (other === field) continue;
    const hit = matches(ov.compatible, label);
    if (hit) return { verdict: READ.INCONSISTENT, reason: `header "${label}" names ${other} (${hit})` };
  }

  for (const title of titles) {
    if (matches(v.excluded, title) || matches(v.incompatible, title)) {
      return { verdict: READ.INCONSISTENT, reason: `title "${title}" over "${label}" is not ${field}` };
    }
    const hit = matches(v.compatible, title);
    if (hit) return { verdict: READ.CONSISTENT, reason: `title "${title}" over "${label}" names ${field} (${hit})` };
  }
  return { verdict: READ.INDETERMINATE, reason: `header "${label}" names neither ${field} nor anything excluded` };
}

const indeterminate = (reason, extra = {}) => ({ verdict: READ.INDETERMINATE, reason, header: null, ...extra });

/**
 * Is the cited cell read under a header compatible with the field?
 *
 * @param {string | ((page:number) => string)} page  the cited page's canonical
 *   text, or a reader returning it for `citation.page`
 * @param {string} field
 * @param {{page:number, start:number, end:number} | null} citation
 * @returns {{verdict:'consistent'|'inconsistent'|'indeterminate', reason:string, header:string|null}}
 */
export function checkRead(page, field, citation) {
  if (!citation) return indeterminate('no citation');
  let text = page;
  if (typeof page === 'function') {
    try {
      text = page(citation.page);
    } catch {
      return indeterminate(`no page ${citation.page}`);
    }
  }
  if (typeof text !== 'string') return indeterminate('no page text');

  const located = locateCell(text, citation.start, citation.end);
  if (located.reason) return indeterminate(located.reason);

  const lines = text.split('\n');
  const header = findHeader(lines, located.lineIndex);
  if (header.reason) return indeterminate(header.reason);

  const aligned = alignCell(located.cells, located.cellIndex, header.cells);
  if (aligned.reason) return indeterminate(aligned.reason);

  const label = header.cells[aligned.index].text.trim();
  const siblings = header.cells.filter((_, i) => i !== aligned.index).map((c) => c.text);
  const judged = judgeLabel(field, label, { siblings, titles: header.titles });
  return { ...judged, header: label };
}

/**
 * Aggregate read checks over a set's answered fields, beside their outcomes.
 *
 * @param {{verdict:string, outcome:string}[]} rows  one per ANSWERED field
 * @returns the counts, the inconsistent share of what was checkable (null when
 *   nothing was), and how the flags line up with what the answers turned out
 *   to be: of the flagged answers, how many were wrong (error or
 *   hallucination), and of the wrong answers, how many were flagged. Each
 *   ratio is null when its denominator is zero, never 0.
 */
export function summarizeReadChecks(rows) {
  const tally = () => ({ hit: 0, error: 0, hallucination: 0 });
  const out = {
    answered: rows.length,
    consistent: 0,
    inconsistent: 0,
    indeterminate: 0,
    flagged: tally(),
    passed: tally(),
  };
  let wrong = 0;
  for (const { verdict, outcome } of rows) {
    if (!(verdict in { consistent: 1, inconsistent: 1, indeterminate: 1 })) {
      throw new Error(`unknown read verdict ${verdict}`);
    }
    out[verdict]++;
    const isWrong = outcome === 'error' || outcome === 'hallucination';
    if (isWrong) wrong++;
    if (verdict === READ.INCONSISTENT && outcome in out.flagged) out.flagged[outcome]++;
    if (verdict === READ.CONSISTENT && outcome in out.passed) out.passed[outcome]++;
  }
  const checked = out.consistent + out.inconsistent;
  const wrongFlagged = out.flagged.error + out.flagged.hallucination;
  out.checked = checked;
  out.inconsistentRate = checked === 0 ? null : out.inconsistent / checked;
  out.wrongAnswered = wrong;
  out.wrongFlagged = wrongFlagged;
  // Of the flagged answers, the share that were wrong.
  out.flagPrecision = out.inconsistent === 0 ? null : wrongFlagged / out.inconsistent;
  // Of the wrong answers, the share that were flagged.
  out.wrongRecall = wrong === 0 ? null : wrongFlagged / wrong;
  return out;
}

const ANSWERED = new Set(['hit', 'error', 'hallucination']);

/**
 * Read-check every answered field of a scored set.
 *
 * @param {{item:string, predicted:Object, pageText:Function|string, byField:Object}[]} docScores
 *   scoreDocument results with the prediction and page reader they were scored from
 * @returns summarizeReadChecks over the answered fields, plus `flags`: each
 *   inconsistent answer with its outcome and header, so a flag can be checked
 *   against the filing by hand
 */
export function readConsistency(docScores) {
  const rows = [];
  const flags = [];
  for (const d of docScores) {
    for (const [field, cell] of Object.entries(d.byField)) {
      if (!ANSWERED.has(cell.outcome)) continue;
      const r = checkRead(d.pageText, field, d.predicted?.[field]?.citation ?? null);
      rows.push({ verdict: r.verdict, outcome: cell.outcome });
      if (r.verdict === READ.INCONSISTENT) {
        flags.push({ item: d.item, field, outcome: cell.outcome, header: r.header, reason: r.reason });
      }
    }
  }
  return { ...summarizeReadChecks(rows), flags };
}
