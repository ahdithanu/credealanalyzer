/**
 * tableReader v1, frozen exactly as scored in commit 869c621. Kept so that v2
 * and v1 can be compared on the same fresh holdout. Do not edit: a change here
 * makes every number recorded against v1 unreproducible.
 */
/**
 * The first extractor: a reader of the tables a 10-K already puts its
 * per-property facts in. No model, no network, deterministic.
 *
 * It exists to set a bar, not to be the product. Anything cleverer has to beat
 * it, and it is cheap enough to beat that the comparison is honest. It also
 * fails in ways that are easy to read, which matters for a first number.
 *
 * Given a filing's canonical text (./text.js) and a subject — the property's
 * name as the filing's property table prints it — it:
 *
 *   1. finds every table row whose first or second cell IS the subject
 *      (footnote markers and a trailing "(State)" ignored; for names carrying
 *      a ", ST 12345" suffix, progressively shorter name prefixes are tried
 *      so "Tower Shopping Center Springfield, VA 22150" finds the Schedule III
 *      row "TOWER SHOPPING CENTER (Virginia)")
 *   2. reads each row against the nearest header above it, aligning cells
 *      from the property column, and maps header text to fields
 *   3. reads Schedule III's trailing date cells by the header's stated order
 *      (construction-then-acquired, or the reverse), and ABSTAINS when a row
 *      carries one date where the header has two, because the text cannot
 *      say which column it came from
 *   4. joins location-only Schedule III rows ("Pensacola, FL") to a subject
 *      only when exactly one row and exactly one property share the location
 *
 * The first statement found wins, which in a 10-K means Item 2 before
 * Schedule III — the same primary-table rule the labels follow.
 *
 * Every answer is `quality: 'sourced'` with a citation to the exact cell, so
 * groundedness checks the extractor's pointer as well as its value.
 */

import { classifyPropertyTypeV1 as classifyPropertyType } from './schema.js';

const FOOTNOTES = /(\s*\(\d+\))+\s*$/;
const DATA_NUMBER = /^[$(]?-?\d{1,3}(,\d{3})+(\.\d+)?\)?$|^-?\d+\.\d+%?$|^\d+%$/;

const norm = (s) => s.replace(FOOTNOTES, '').replace(/\s*\([A-Za-z ]+\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Split the text into lines with their offsets, and each line into cells with theirs. */
function index(text) {
  const lines = [];
  let pos = 0;
  for (const raw of text.split('\n')) {
    const cells = [];
    let at = 0;
    for (const part of raw.split(' | ')) {
      cells.push({ text: part, start: pos + at, end: pos + at + part.length });
      at += part.length + 3;
    }
    lines.push({ raw, start: pos, cells });
    pos += raw.length + 1;
  }
  return lines;
}

const isHeader = (line) => line.cells.length >= 3
  && line.cells.every((c) => !DATA_NUMBER.test(c.text.trim()) && c.text.length < 90);

function headerBlock(lines, i) {
  // The nearest header line above, and up to five header lines contiguous with
  // it, which is how multi-row Schedule III headers come out of the converter.
  let h = i - 1;
  while (h >= 0 && i - h < 120 && !isHeader(lines[h])) h--;
  if (h < 0 || i - h >= 120) return null;
  const block = [lines[h]];
  for (let k = h - 1; k >= 0 && h - k <= 5 && isHeader(lines[k]); k--) block.unshift(lines[k]);
  return { primary: lines[h], text: block.map((l) => l.raw).join(' | ') };
}

function nameKeys(subject) {
  const keys = [norm(subject)];
  const m = subject.match(/^(.*?),\s*[A-Z]{2}\s+\d{5}$/);
  if (m) {
    const words = m[1].trim().split(/\s+/);
    for (let n = words.length - 1; n >= 2; n--) keys.push(norm(words.slice(0, n).join(' ')));
  }
  return keys;
}

function locationOf(subject) {
  const m = subject.match(/[—–-]\s*([A-Za-z .']+,\s*[A-Z]{2})\s*$/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function parseYear(s) {
  const m = String(s).trim().match(/^(\d{4})(?!\s*-\s*\d)/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1600 && y <= 2100 ? y : null;
}

const parseCount = (s) => (/^\d{1,3}(,\d{3})*$|^\d+$/.test(s.trim()) ? Number(s.replace(/,/g, '')) : null);
const parsePercent = (s) => {
  const m = s.trim().match(/^(\d{1,3}(?:\.\d+)?)%$/);
  return m ? Number(m[1]) : null;
};
const looksLikeStreet = (s) => /^\d[\d-]*\s+[A-Za-z0-9]/.test(s.trim());

const DATE_CELL = /^(\d{4}\b|[A-Z][a-z]{2,4}\.?\s?-\s?\d{4}$|\d{1,2}\/\d{1,2}\/\d{2,4})/;

const sourced = (value, cell, confidence) => ({
  value, quality: 'sourced', confidence, citation: { page: 1, start: cell.start, end: cell.end },
});

function readAligned(row, subjectIdx, header, out) {
  const hcells = header.primary.cells;
  const propIdx = hcells.findIndex((c) => /property|description|address/i.test(c.text));
  if (propIdx < 0) return;
  const offset = propIdx - subjectIdx;
  for (let i = 0; i < row.cells.length; i++) {
    const h = hcells[i + offset];
    if (!h) continue;
    const label = h.text;
    const cell = row.cells[i];
    const v = cell.text.trim();

    if (/total property/i.test(label) || (/square\s*f(?:ee|oo)t/i.test(label) && !/per|rent|share/i.test(label))) {
      const n = /units?/i.test(v) ? null : parseCount(v);
      if (n !== null) set(out, 'squareFeet', sourced(n, cell, 0.9));
    } else if (/occupan/i.test(label) && !/leased|per occupied|rent/i.test(label)) {
      const p = parsePercent(v);
      if (p !== null) set(out, 'occupancy', sourced(p, cell, 0.9));
    } else if (/\btype\b/i.test(label)) {
      const t = classifyPropertyType(v);
      if (t) set(out, 'propertyType', sourced(t, cell, 0.9));
    } else if (/year built|year completed|date of construction|built/i.test(label)) {
      const y = parseYear(v);
      if (y !== null) set(out, 'yearBuilt', sourced(y, cell, 0.9));
    } else if (/address/i.test(label) && looksLikeStreet(v)) {
      set(out, 'address', sourced(v.replace(FOOTNOTES, ''), cell, 0.9));
    }
  }
}

function readScheduleDates(row, header, out) {
  const h = header.text.toLowerCase();
  const built = h.search(/construct|year built|built\//);
  const acquired = h.search(/acquired/);
  if (built < 0 || acquired < 0) return;
  let lastMoney = -1;
  row.cells.forEach((c, i) => { if (/\d,\d{3}/.test(c.text)) lastMoney = i; });
  const dates = row.cells.slice(lastMoney + 1).filter((c) => DATE_CELL.test(c.text.trim()));
  // One date where the header promises two: the text no longer says which
  // column it sat in. Guessing here is exactly the hallucination being measured.
  if (dates.length !== 2) return;
  const cell = built < acquired ? dates[0] : dates[1];
  const y = parseYear(cell.text);
  if (y !== null) set(out, 'yearBuilt', sourced(y, cell, 0.85));
}

function set(out, field, answer) {
  if (!out[field]) out[field] = answer;
}

/**
 * @param {string} text     canonical filing text from htmlToText
 * @param {string} subject  the property as the filing's property table names it
 * @returns {Object} field -> {value, quality, confidence, citation}
 */
export function extractFromFiling(text, subject) {
  const lines = index(text);
  const keys = nameKeys(subject);
  const out = {};

  // Longest matching key wins, so a short prefix never shadows the full name.
  const matches = [];
  for (const key of keys) {
    for (let i = 0; i < lines.length; i++) {
      const row = lines[i];
      if (row.cells.length < 4) continue;
      const idx = row.cells.slice(0, 2).findIndex((c) => norm(c.text) === key);
      if (idx >= 0 && !matches.some((m) => m.i === i)) matches.push({ i, idx, key });
    }
    if (matches.length && key === keys[0]) break;
  }
  matches.sort((a, b) => a.i - b.i);

  for (const { i, idx } of matches) {
    const row = lines[i];
    const header = headerBlock(lines, i);
    if (!header) continue;
    readAligned(row, idx, header, out);
    readScheduleDates(row, header, out);
    // The subject cell itself is a street address, under a property/address
    // column. Judge the header cell the subject ALIGNS with, not the header's
    // first cell: a table that leads with "Market" still names properties.
    const propIdx = header.primary.cells.findIndex((c) => /property|description|address/i.test(c.text));
    if (looksLikeStreet(subject) && !out.address && propIdx >= 0 && propIdx >= idx) {
      const cell = row.cells[idx];
      set(out, 'address', sourced(cell.text.replace(FOOTNOTES, '').trim(), cell, 0.95));
    }
  }

  const loc = locationOf(subject);
  if (loc && !out.yearBuilt) {
    const locRows = lines.filter((l) => l.cells.length >= 6 && l.cells[0].text.trim() === loc);
    const subjectRows = lines.filter((l) => l.cells.length >= 4 && locationOf(l.cells[0].text.replace(FOOTNOTES, '')) === loc);
    if (locRows.length === 1 && subjectRows.length === 1) {
      const i = lines.indexOf(locRows[0]);
      const header = headerBlock(lines, i);
      if (header) readScheduleDates(locRows[0], header, out);
    }
  }

  if (!out.propertyType) {
    const t = classifyPropertyType(subject);
    if (t) {
      const at = text.indexOf(subject);
      if (at >= 0) out.propertyType = sourced(t, { start: at, end: at + subject.length }, 0.7);
    }
  }
  return out;
}
