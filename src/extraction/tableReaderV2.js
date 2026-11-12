/**
 * tableReader v2, frozen exactly as scored in commit cf32743. Kept so v1, v2
 * and v3 can be compared on the same fresh data. Do not edit.
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

// A header names columns; it does not carry values. v1 judged that only by the
// absence of comma-formatted numbers, so a Schedule III row whose figures were
// all under 1,000 ("334 | 428 | 2 | ...") passed as a header and hid the real
// one. Bare numbers that are not plausible years, and nil markers, now mark a
// line as data. Years stay allowed: BRT's header is "2025 | 2024 | ...".
const BARE_NON_YEAR = (t) => /^-?\d+$/.test(t) && !(Number(t) >= 1900 && Number(t) <= 2100);
const NIL = /^(—|–|-|-\(\d+\))$/;
const isHeader = (line) => line.cells.length >= 3
  && line.cells.every((c) => {
    const t = c.text.trim();
    return !DATA_NUMBER.test(t) && !BARE_NON_YEAR(t) && !NIL.test(t) && c.text.length < 90;
  });

function headerBlock(lines, i) {
  // The nearest header line above, and up to five header lines contiguous with
  // it, which is how multi-row Schedule III headers come out of the converter.
  let h = i - 1;
  while (h >= 0 && i - h < 120 && !isHeader(lines[h])) h--;
  if (h < 0 || i - h >= 120) return null;
  const block = [lines[h]];
  for (let k = h - 1; k >= 0 && h - k <= 5 && isHeader(lines[k]); k--) block.unshift(lines[k]);
  return {
    primary: lines[h], block, firstIdx: h - block.length + 1,
    text: block.map((l) => l.raw).join(' | '),
  };
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
// A building number followed by a street name. v1 accepted any leading number,
// so the property NAME "1322 North —Auburn, AL" came back as an address, with
// a grounded citation. A trailing location ("— Auburn, AL", ", VA 22202") now
// disqualifies a string: an address cell in these tables never carries one,
// and a name-and-location cell always does.
const looksLikeStreet = (s) => {
  const t = s.trim();
  if (/[—–]\s*[A-Za-z .']+,\s*[A-Z]{2}\s*$|,\s*[A-Z]{2}(\s+\d{5})?\s*$/.test(t)) return false;
  return /^\d[\d-]*\s+[A-Za-z0-9]/.test(t);
};

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

/**
 * Grouped year columns under a spanning label. BRT prints
 *
 *   Our Percentage Ownership (%) | Average Monthly Rental Rate ... | Average Physical Occupancy (%)
 *   Property Name and Location | Number of Units | Age | Acquisition Date | 2025 | 2024 | ... | 2025 | 2024 | ...
 *
 * and each row carries one more cell than the second line, because the
 * single-column "Ownership" label has no year under it. Reading by left
 * alignment puts occupancy under a rent year. So: when the primary header ends
 * in runs of years, align from the RIGHT, give each run the spanning label
 * above it (also right-aligned), and read the most recent year of a run whose
 * label is occupancy.
 */
function readGrouped(row, header, out) {
  const P = header.primary.cells;
  const isYear = (c) => /^\d{4}$/.test(c.text.trim()) && Number(c.text) >= 1900 && Number(c.text) <= 2100;
  if (!P.length || !isYear(P[P.length - 1]) || header.block.length < 2) return;
  if (row.cells.length < P.length) return;

  const runs = [];
  for (let i = 0; i < P.length; i++) {
    if (!isYear(P[i])) continue;
    if (i > 0 && isYear(P[i - 1]) && Number(P[i].text) < Number(P[i - 1].text)) runs[runs.length - 1].push(i);
    else runs.push([i]);
  }
  const grouped = runs.filter((r) => r.length >= 2);
  const spans = header.block[header.block.length - 2].cells;
  if (!grouped.length || spans.length < grouped.length) return;

  const shift = row.cells.length - P.length;
  grouped.forEach((run, k) => {
    const label = spans[spans.length - grouped.length + k].text;
    if (!/occupan/i.test(label) || /leased|rent/i.test(label)) return;
    const newest = run.reduce((a, b) => (Number(P[b].text) > Number(P[a].text) ? b : a));
    const cell = row.cells[newest + shift];
    const v = cell?.text.trim() ?? '';
    const p = parsePercent(v) ?? (/%/.test(label) && /^\d{1,3}(\.\d+)?$/.test(v) && Number(v) <= 100 ? Number(v) : null);
    if (p !== null) set(out, 'occupancy', sourced(p, cell, 0.85));
  });
}

/**
 * A type stated by a heading the table sits under ("Our Multi-Family
 * Properties"). Only a heading naming ONE category counts: "Retail and
 * Residential Properties" describes a table holding both kinds, not rows that
 * are each mixed-use, and the labelling rules say the same.
 */
function headingType(lines, firstHeaderIdx) {
  for (let k = firstHeaderIdx - 1; k >= 0 && firstHeaderIdx - k <= 4; k--) {
    const l = lines[k];
    if (l.cells.length > 1 || l.raw.length >= 80) continue;
    const t = classifyPropertyType(l.raw);
    if (t === 'mixed-use') return null;
    if (t) return { type: t, cell: { start: l.start, end: l.start + l.raw.length } };
  }
  return null;
}

/**
 * A purchase price stated in prose. v1 read only tables and missed "The
 * venture acquired the property for $36,500,000".
 *
 * Deliberately narrow, because price is the field an invented value costs the
 * most on. A sentence counts when it says the subject (or "the property", in
 * the sentence right after one naming the subject) was acquired FOR a dollar
 * figure. It does not count when it speaks of several properties or a
 * portfolio, because a portfolio price is not a property price.
 */
const PRICE = /\bacquir(?:ed|es)\b[^.]*?\bfor\s+(?:approximately\s+|about\s+)?(\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s*(thousand|million|billion))?)/i;
const PLURAL = /\bproperties\b|\bportfolio\b|\bassets\b|\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:buildings|properties)\b/i;

function subjectNames(subject) {
  const names = new Set([subject.trim()]);
  const dash = subject.match(/^(.*?)\s*[—–]\s*[A-Za-z .']+,\s*[A-Z]{2}\s*$/);
  if (dash) names.add(dash[1].trim());
  const zip = subject.match(/^(.*?),\s*[A-Z]{2}\s+\d{5}$/);
  if (zip) {
    // "Del Monte Shopping Center Monterey, CA 93940": where the name ends and
    // the city begins is not marked, so every prefix of two or more words is a
    // candidate. mentions() keeps a short one from matching inside a longer
    // name.
    const words = zip[1].trim().split(/\s+/);
    for (let n = words.length; n >= 2; n--) names.add(words.slice(0, n).join(' '));
  }
  return [...names].filter((n) => n.length >= 4);
}

/**
 * The sentence names this property, not a longer name that contains it:
 * "Town Center" inside "Annapolis Town Center" or "Town Center Crossing" is
 * another property. A capitalised word touching either end means the match is
 * part of a longer proper name.
 */
function mentions(text, name) {
  let at = text.indexOf(name);
  while (at >= 0) {
    const before = text.slice(0, at);
    const after = text.slice(at + name.length);
    if (!/[A-Z][\w'&-]*\s$/.test(before) && !/^\s[A-Z]/.test(after)) return true;
    at = text.indexOf(name, at + 1);
  }
  return false;
}

function readProsePrice(lines, subject, out) {
  const names = subjectNames(subject);
  for (const line of lines) {
    if (line.cells.length > 1) continue;
    const sentences = [];
    const re = /[^.]+(?:\.(?!\s+[A-Z])[^.]*)*\.?/g;
    let m;
    while ((m = re.exec(line.raw))) sentences.push({ text: m[0], at: m.index });
    sentences.forEach((sent, k) => {
      const names_ = names.some((n) => mentions(sent.text, n));
      const follows = k > 0 && /\bthe property\b/i.test(sent.text)
        && names.some((n) => mentions(sentences[k - 1].text, n)) && !PLURAL.test(sentences[k - 1].text);
      if ((!names_ && !follows) || PLURAL.test(sent.text)) return;
      const p = sent.text.match(PRICE);
      if (!p) return;
      const value = Number(p[2].replace(/,/g, '')) * ({ thousand: 1e3, million: 1e6, billion: 1e9 }[p[3]?.toLowerCase()] || 1);
      const start = line.start + sent.at + sent.text.indexOf(p[1]);
      set(out, 'purchasePrice', sourced(value, { start, end: start + p[1].length }, 0.8));
    });
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
  let headingFound = null;

  for (const { i, idx } of matches) {
    const row = lines[i];
    const header = headerBlock(lines, i);
    if (!header) continue;
    readAligned(row, idx, header, out);
    readGrouped(row, header, out);
    readScheduleDates(row, header, out);
    if (!headingFound) headingFound = headingType(lines, header.firstIdx);
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
  readProsePrice(lines, subject, out);

  if (!out.propertyType && headingFound) {
    out.propertyType = sourced(headingFound.type, headingFound.cell, 0.75);
  }
  return out;
}
