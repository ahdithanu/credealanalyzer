/**
 * A broker's rent roll spreadsheet, turned into bays the buy box can read.
 *
 * This is the friction between "I have the offering memorandum" and "I have a
 * verdict". Every rent roll in this asset class arrives as a spreadsheet, no
 * two of them have the same column headers, and hand-keying a nine-bay roll is
 * ten minutes of typing that nobody does twice — so the deal gets screened on
 * the summary numbers instead, which is exactly how a 40%-concentration centre
 * reaches an LOI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REFUSES TO DO
 *
 * It does not guess. A column it cannot identify is reported as unmapped, and a
 * value it cannot read is reported as unparsed — both by name, with the row
 * number. The alternative, which is what most importers do, is to coerce
 * everything to a number and let `NaN` become `0`: a rent roll with one
 * unreadable rent column then produces a centre with a plausible-looking
 * shortfall in income, which reads as a value-add opportunity rather than as a
 * parse failure.
 *
 * Both halves of the output matter. `bays` is what the buy box consumes;
 * `issues` is what tells you whether to trust it, and the CLI prints it above
 * the verdict for that reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Header synonyms, lowercased.
 *
 * Collected from how these actually arrive rather than from a standard, because
 * there is no standard. Matching is on a normalised header — punctuation and
 * whitespace stripped — so "Base Rent ($/yr)" and "base_rent_yr" both land.
 */
export const COLUMN_SYNONYMS = {
  tenant: ['tenant', 'tenantname', 'lessee', 'occupant', 'business', 'name', 'dba'],
  suite: ['suite', 'unit', 'bay', 'space', 'suiteno', 'unitno', 'spaceno'],
  squareFeet: ['squarefeet', 'sf', 'sqft', 'squarefootage', 'rentablesf', 'rsf', 'glasf',
    'leasablesf', 'size', 'area', 'unitsf'],
  baseRentAnnual: ['baserentannual', 'annualrent', 'annualbaserent', 'baserentyr',
    'yearlyrent', 'rentpa', 'totalannualrent'],
  baseRentMonthly: ['baserentmonthly', 'monthlyrent', 'rentmonth', 'monthlybaserent',
    'currentrent', 'rent', 'basrent', 'baserent'],
  rentPSF: ['rentpsf', 'psf', 'rentpersf', 'annualpsf', 'baserentpsf', 'rateperssf', 'ratepsf'],
  leaseStart: ['leasestart', 'commencement', 'start', 'leasecommencement', 'begindate',
    'startdate', 'from'],
  leaseEnd: ['leaseend', 'expiration', 'expiry', 'end', 'leaseexpiration', 'enddate',
    'expdate', 'to', 'leaseexpires'],
  recovery: ['recovery', 'leasetype', 'type', 'structure', 'leasestructure', 'camtype', 'nnn'],
  category: ['category', 'use', 'tenanttype', 'usetype', 'industry', 'concept'],
  marketRentPSF: ['marketrentpsf', 'marketrent', 'marketpsf', 'proformapsf', 'proformarent'],
};

/** Strip everything that varies between spreadsheets but not between meanings. */
const normaliseHeader = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * RFC 4180-ish CSV, written out rather than depended on.
 *
 * A rent roll's tenant column contains commas ("Smith, Jones & Co"), so a split
 * on comma is wrong on the first real file. Quoted fields, doubled quotes
 * inside them, and embedded newlines are all handled; everything else about
 * CSV is not worth a dependency in a tree with three of them.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',' || c === '\t') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Trailing blank lines are not rows.
  return rows.filter((r) => r.some((f) => String(f).trim() !== ''));
}

/**
 * The conventional ways a spreadsheet says "nothing here".
 *
 * Distinguished from an unreadable value, and the distinction is what keeps the
 * issue list worth reading: "N/A" is the broker telling you there is no figure,
 * while "approx 1600" is a cell with content the parser could not use. Flagging
 * both means a clean rent roll with four N/As produces four warnings, and a
 * list that cries wolf is a list nobody reads by the third deal.
 */
export const BLANK = /^(n\/?a|-+|tbd|vacant|none|null)$/i;

/**
 * Units a spreadsheet legitimately appends to a figure. Stripped; anything
 * else alphabetic makes the cell unreadable rather than partially read.
 */
const UNIT_SUFFIX = /(sf|sqft|sq|ft|psf|yr|year|yrs|mo|month|months|pa|annum|nnn)+$/;

/**
 * Money and measurements, as spreadsheets write them.
 *
 * Handles $, thousands separators, unit suffixes, and accounting negatives —
 * `(1,200)` is -1200 in every rent roll produced by an accountant, and reading
 * it as 1200 flips the sign on a concession.
 */
function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '' || BLANK.test(s)) return null;
  const negative = /^\(.*\)$/.test(s);

  // Punctuation and whitespace go, then a trailing unit. What remains must be
  // ENTIRELY numeric.
  //
  // The earlier version stripped every non-digit instead, which reads
  // "approx 1600" as 1600 — losing the word that says it is an estimate — and,
  // far worse, reads "Bldg 3" as 3. A parser that extracts a number from
  // arbitrary text will eventually extract one from a cell that was never a
  // measurement, and that number is indistinguishable downstream from a real
  // one. Refusing the cell puts it on the issue list where somebody looks at it.
  const stripped = s.replace(/[()$,\s]/g, '').replace(/\/(yr|year|mo|month|sf)$/i, '');
  const withoutUnit = stripped.replace(new RegExp(UNIT_SUFFIX.source + '$', 'i'), '');
  //
  // The shape is deliberate about three cases that `Number()` gets wrong here:
  //   0x10      → Number gives 16. Hex is never a rent roll figure, and 16 is
  //               indistinguishable downstream from a measured 16. Rejected.
  //   1.2E+05   → Number gives 120000, and that is what Excel meant when it
  //               exported a wide column in scientific notation. Accepted.
  //   +40       → a harmless leading sign a spreadsheet leaves behind. Accepted.
  // Found by mutation testing: removing this check failed nothing, because
  // `Number()` already rejects the obvious garbage. These four are what it
  // does not reject.
  if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(withoutUnit)) return null;

  const n = Number(withoutUnit);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/**
 * Dates, as spreadsheets write them.
 *
 * US month-first is assumed for ambiguous all-numeric dates, because these are
 * US rent rolls — and the assumption is RECORDED on the issue list when it was
 * actually load-bearing (day ≤ 12, so the value is genuinely ambiguous) rather
 * than announced every time.
 */
function parseDate(raw, onAmbiguous) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s === '' || /^(n\/?a|-+|mtm|month.?to.?month|holdover)$/i.test(s)) return null;

  const numeric = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (numeric) {
    const [, a, b, y] = numeric;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    if (Number(a) <= 12 && Number(b) <= 12 && Number(a) !== Number(b)) onAmbiguous?.(s);
    const d = new Date(Date.UTC(year, Number(a) - 1, Number(b)));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** 'NNN', 'Triple Net', 'Modified Gross', 'Gross' → the engine's three values. */
function parseRecovery(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (/nnn|triple\s*net/.test(s)) return 'nnn';
  if (/modified|nn\b|double\s*net|mg\b/.test(s)) return 'modified';
  if (/gross|full\s*service|fsg/.test(s)) return 'gross';
  return null;
}

/**
 * Did this cell have content the parser could not use?
 *
 * Empty and conventional blanks are absences, not failures. Everything else
 * that came back null had something in it, and that is worth a line on the
 * issue list.
 */
function unreadable(raw, parsed) {
  if (parsed !== null) return false;
  if (raw === undefined || raw === null) return false;
  const s = String(raw).trim();
  return s !== '' && !BLANK.test(s);
}

/** Is this row an empty bay rather than a tenant? */
function looksVacant(cells) {
  const joined = Object.values(cells).map((v) => String(v ?? '')).join(' ').toLowerCase();
  return /\bvacant\b|\bavailable\b|\bempty\b/.test(joined);
}

/**
 * Parse a rent roll.
 *
 * @param {string} text  CSV or TSV
 * @param {object} [opts]
 * @param {object} [opts.columns]  explicit header → field overrides, for the
 *   file whose headers this module cannot recognise. Beats guessing.
 * @returns {{bays: Array, issues: Array, mapping: object, unmapped: string[]}}
 */
export function parseRentRollCsv(text, { columns = {} } = {}) {
  const rows = parseCsv(text);
  const issues = [];
  if (!rows.length) {
    return { bays: [], issues: [{ kind: 'empty', message: 'no rows' }], mapping: {}, unmapped: [] };
  }

  // ── Find the header row ──────────────────────────────────────────────────
  // Rent rolls routinely open with a title and a blank line, so the first row
  // is often not the header. The header is the first row that maps at least
  // two known columns — one is a coincidence, two is a header.
  let headerIndex = -1;
  let mapping = {};
  for (let r = 0; r < Math.min(rows.length, 10); r += 1) {
    const candidate = {};
    rows[r].forEach((h, i) => {
      const norm = normaliseHeader(h);
      if (!norm) return;
      const explicit = columns[String(h).trim()] || columns[norm];
      if (explicit) { candidate[i] = explicit; return; }
      for (const [field, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
        if (synonyms.includes(norm)) { candidate[i] = field; return; }
      }
    });
    if (Object.keys(candidate).length >= 2) { headerIndex = r; mapping = candidate; break; }
  }
  if (headerIndex === -1) {
    return {
      bays: [],
      issues: [{
        kind: 'no-header',
        message: 'no row looked like a header. Pass { columns: { "Your Header": "squareFeet" } } '
          + `to map explicitly. Known fields: ${Object.keys(COLUMN_SYNONYMS).join(', ')}`,
      }],
      mapping: {},
      unmapped: rows[0] || [],
    };
  }

  const unmapped = rows[headerIndex]
    .map((h, i) => (mapping[i] ? null : String(h).trim()))
    .filter((h) => h);

  // ── Rows ─────────────────────────────────────────────────────────────────
  const bays = [];
  let ambiguousDates = 0;

  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const cells = {};
    rows[r].forEach((v, i) => { if (mapping[i]) cells[mapping[i]] = v; });
    if (!Object.keys(cells).length) continue;

    const line = r + 1;   // 1-based, as a spreadsheet numbers it

    // A totals row is not a bay. Including one doubles the centre's rent and
    // creates a phantom tenant holding 50% of it — which the concentration
    // test would then correctly flag on a roll that is actually fine.
    const tenantText = String(cells.tenant ?? '').trim();
    if (/^(total|totals|subtotal|grand\s*total|sum)\b/i.test(tenantText)) continue;

    const vacant = looksVacant(cells);
    const sf = parseNumber(cells.squareFeet);
    if (unreadable(cells.squareFeet, sf)) {
      issues.push({ kind: 'unparsed', line, field: 'squareFeet', raw: cells.squareFeet });
    }

    // Annual rent, from whichever of the three ways it was given. Monthly and
    // per-SF are converted; the conversion is noted so a reader can see that
    // the annual figure was derived rather than stated.
    let baseRentAnnual = parseNumber(cells.baseRentAnnual);
    let rentBasis = baseRentAnnual === null ? null : 'annual';
    if (baseRentAnnual === null) {
      const monthly = parseNumber(cells.baseRentMonthly);
      if (monthly !== null) { baseRentAnnual = monthly * 12; rentBasis = 'monthly×12'; }
    }
    if (baseRentAnnual === null) {
      const psf = parseNumber(cells.rentPSF);
      if (psf !== null && sf !== null) { baseRentAnnual = psf * sf; rentBasis = 'psf×sf'; }
      else if (psf !== null && sf === null) {
        issues.push({
          kind: 'unusable', line, field: 'rentPSF',
          message: 'rent given per SF but the bay has no square footage, so annual rent '
            + 'cannot be derived',
        });
      }
    }
    if (!vacant && baseRentAnnual === null) {
      issues.push({
        kind: 'missing', line, field: 'baseRentAnnual', tenant: tenantText || null,
        message: 'an occupied bay with no readable rent. It will be excluded from rent '
          + 'totals, concentration and WALT.',
      });
    }

    const leaseEnd = parseDate(cells.leaseEnd, () => { ambiguousDates += 1; });
    const leaseStart = parseDate(cells.leaseStart, () => { ambiguousDates += 1; });

    bays.push({
      ...(vacant
        ? { vacant: true, category: 'vacant' }
        : { tenant: tenantText || `Suite ${String(cells.suite ?? line).trim()}` }),
      ...(cells.suite !== undefined ? { suite: String(cells.suite).trim() } : {}),
      squareFeet: sf,
      ...(baseRentAnnual === null ? {} : { baseRentAnnual }),
      ...(rentBasis ? { rentBasis } : {}),
      ...(leaseStart ? { leaseStart } : {}),
      ...(leaseEnd ? { leaseEnd } : {}),
      ...(parseRecovery(cells.recovery) ? { recovery: parseRecovery(cells.recovery) } : {}),
      ...(cells.category && !vacant ? { categoryRaw: String(cells.category).trim() } : {}),
      ...(parseNumber(cells.marketRentPSF) === null
        ? {} : { marketRentPSF: parseNumber(cells.marketRentPSF) }),
      sourceLine: line,
    });
  }

  if (ambiguousDates) {
    issues.push({
      kind: 'assumption',
      message: `${ambiguousDates} date(s) were ambiguous (day and month both ≤ 12) and were `
        + 'read US-style, month first. Check any lease expiry that looks wrong by months.',
    });
  }
  if (unmapped.length) {
    issues.push({
      kind: 'unmapped',
      message: `columns not recognised and ignored: ${unmapped.join(', ')}`,
    });
  }
  // A roll with no category column is the normal case, and it means the
  // restaurant-share criterion cannot be tested. Said once, here, rather than
  // discovered as an `unknown` verdict with no explanation.
  if (!Object.values(mapping).includes('category')) {
    issues.push({
      kind: 'note',
      message: 'no tenant-use column, so restaurant share and Amazon-resistance cannot be '
        + 'measured. Add a `category` column, or set it per bay before screening.',
    });
  }

  return { bays, issues, mapping, unmapped };
}
