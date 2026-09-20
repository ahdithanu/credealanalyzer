/**
 * One listing, assembled from several sources that disagree.
 *
 * Ingestion is not a parsing problem. Parsing a broker flyer is an afternoon;
 * the hard part is that by the time you write an LOI you have the same property
 * described four times — a teaser email, an offering memorandum, a rent roll
 * spreadsheet, and the county assessor — and they do not agree. The flyer says
 * 14,000 square feet, the assessor says 11,200, and the rent roll's bays add up
 * to 12,400. All three are "the building size".
 *
 * THE DESIGN DECISION THIS FILE IS: a merge that silently picks a winner hides
 * the discrepancy, and the discrepancy is the finding. 11,200 against 14,000 at
 * $200/SF is a $560,000 difference in what you are buying. So every field
 * carries where it came from, conflicts are RECORDED rather than resolved away,
 * and the merged record can always say "three sources, here is the spread".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRUST, AND WHY IT IS NOT THE WHOLE ANSWER
 *
 * Sources are ranked, and the rank decides which value leads. It does NOT
 * decide whether the others were wrong:
 *
 *   measured    you counted the parking spaces yourself
 *   public      state DOT traffic counts, census, county assessor
 *   document    rent roll, offering memorandum — the seller's representation,
 *               and the thing they will have to stand behind at closing
 *   marketing   flyer, teaser, portal listing. A number chosen to sell.
 *   estimate    a house default or a model output
 *
 * `marketing` sits below `document` for one reason worth stating: a broker's
 * "25,000 vehicles per day" and a state DOT count are not the same claim, and a
 * system that cannot tell them apart will screen a deal in on the strength of a
 * flyer. The rank is about provenance, not about anybody's honesty.
 *
 * WHERE RANK IS THE WRONG TOOL, and the reason conflicts are reported instead
 * of resolved: an assessor's gross building area and a rent roll's leasable
 * area are BOTH RIGHT and differ by the common-area load. There is no ranking
 * that makes that a solved problem — only a report that shows both and lets a
 * human decide which one the price should be divided by.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const SOURCE_TRUST = {
  measured: 5,
  public: 4,
  document: 3,
  marketing: 2,
  estimate: 1,
};

/**
 * Fields where two sources differing is expected rather than suspicious, with
 * the reason. Surfaced on the conflict so a reader is not sent chasing a
 * reconciliation that does not exist.
 */
export const EXPECTED_DIVERGENCE = {
  buildingSize:
    'Gross building area (assessor) and gross leasable area (rent roll) differ by the '
    + 'common-area load and are both correct. Decide which one the price per SF is on.',
  occupancyPct:
    'A rent roll is a point in time and a flyer may be months old. Check the rent roll date.',
};

/**
 * How far apart two numbers have to be before it is a conflict worth raising.
 *
 * Relative, not absolute, because the fields are on wildly different scales —
 * a 500 difference is nothing on a traffic count and is most of a bay. 2% is
 * below the rounding in any broker document, so anything above it was a
 * genuinely different measurement rather than a typo in the last digit.
 */
export const CONFLICT_TOLERANCE = 0.02;

/** Finite number, or null. */
function finite(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A single observation of a single field.
 *
 * @typedef {object} Observation
 * @property {*} value
 * @property {keyof SOURCE_TRUST} sourceKind
 * @property {string} sourceName   'Coldwell teaser 2026-03-04', 'Franklin County assessor'
 * @property {string} [asOf]       ISO date the source describes, not when it was read
 */

/**
 * Build an observation set for one property from several parsed sources.
 *
 * @param {Array<{sourceKind: string, sourceName: string, asOf?: string, fields: object}>} sources
 */
export function observe(sources = []) {
  const byField = new Map();
  for (const s of sources) {
    if (!SOURCE_TRUST[s.sourceKind]) {
      throw new Error(
        `unknown sourceKind ${JSON.stringify(s.sourceKind)}; `
        + `expected one of ${Object.keys(SOURCE_TRUST).join(', ')}`,
      );
    }
    for (const [field, value] of Object.entries(s.fields || {})) {
      if (value === null || value === undefined || value === '') continue;
      const list = byField.get(field) || [];
      list.push({
        value,
        sourceKind: s.sourceKind,
        sourceName: s.sourceName,
        asOf: s.asOf || null,
      });
      byField.set(field, list);
    }
  }
  return byField;
}

/**
 * Pick the leading observation for a field.
 *
 * Trust first, then recency within the same trust level. Recency does NOT beat
 * trust: a flyer sent this morning does not outrank an assessor record from
 * last year, because the flyer was never a measurement.
 */
function lead(observations) {
  return [...observations].sort((a, b) => {
    const t = SOURCE_TRUST[b.sourceKind] - SOURCE_TRUST[a.sourceKind];
    if (t !== 0) return t;
    if (a.asOf && b.asOf) return b.asOf.localeCompare(a.asOf);
    if (a.asOf) return -1;
    if (b.asOf) return 1;
    return 0;
  })[0];
}

/** Do two observations of the same field disagree materially? */
function disagrees(a, b) {
  const na = finite(a.value);
  const nb = finite(b.value);
  if (na !== null && nb !== null) {
    const scale = Math.max(Math.abs(na), Math.abs(nb));
    if (scale === 0) return false;
    return Math.abs(na - nb) / scale > CONFLICT_TOLERANCE;
  }
  // Non-numeric: a plain inequality, case- and space-insensitive so
  // "Shadow anchored" and "shadow-anchored" are not a finding.
  const norm = (v) => String(v).trim().toLowerCase().replace(/[\s-]+/g, ' ');
  return norm(a.value) !== norm(b.value);
}

/**
 * Merge every source into one record, plus the list of what disagreed.
 *
 * @returns {{
 *   fields: object,                      the leading value per field
 *   provenance: object,                  where each leading value came from
 *   conflicts: Array,                    every material disagreement
 *   sources: Array                       what went in
 * }}
 */
export function mergeListing(sources = []) {
  const byField = observe(sources);
  const fields = {};
  const provenance = {};
  const conflicts = [];

  for (const [field, observations] of byField) {
    const winner = lead(observations);
    fields[field] = winner.value;
    provenance[field] = {
      sourceKind: winner.sourceKind,
      sourceName: winner.sourceName,
      asOf: winner.asOf,
      // How many sources saw this field at all. One source agreeing with itself
      // is not corroboration, and a reader should be able to tell.
      observationCount: observations.length,
    };

    const dissenting = observations.filter((o) => o !== winner && disagrees(winner, o));
    if (dissenting.length) {
      const numeric = observations.map((o) => finite(o.value)).filter((n) => n !== null);
      conflicts.push({
        field,
        // The leading value and every value that disagreed with it, each with
        // its source, so the reader can decide rather than be told.
        leading: { value: winner.value, source: winner.sourceName, kind: winner.sourceKind },
        dissenting: dissenting.map((o) => ({
          value: o.value, source: o.sourceName, kind: o.sourceKind,
        })),
        spreadPct: numeric.length > 1 && Math.max(...numeric) !== 0
          ? ((Math.max(...numeric) - Math.min(...numeric)) / Math.max(...numeric)) * 100
          : null,
        expected: EXPECTED_DIVERGENCE[field] || null,
      });
    }
  }

  return {
    fields,
    provenance,
    // Widest spread first: the field where the sources disagree most is the one
    // to reconcile before an LOI, not the one that happens to sort first.
    conflicts: conflicts.sort((a, b) => (b.spreadPct ?? 0) - (a.spreadPct ?? 0)),
    sources: sources.map((s) => ({
      kind: s.sourceKind, name: s.sourceName, asOf: s.asOf || null,
      fieldCount: Object.keys(s.fields || {}).length,
    })),
  };
}

/**
 * Identity, for deduplicating the same property arriving from four places.
 *
 * Address only, normalised — NOT name. The same centre is "Maple Crossing",
 * "Maple Crossing Shopping Center" and "4500 Maple Ave" across three brokers,
 * and matching on name produces four records for one property, each screened
 * separately and each incomplete in a different way.
 *
 * Returns null when there is no address to key on. A null key must never
 * collide with another null key, so callers treat it as "cannot dedupe this
 * one" rather than as a group.
 */
export function listingKey({ address, city, state } = {}) {
  if (!address || !city || !state) return null;
  const street = String(address)
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    // Common abbreviations, so "4500 Maple Avenue" and "4500 Maple Ave" agree.
    .replace(/\b(street|str)\b/g, 'st')
    .replace(/\b(avenue|av)\b/g, 'ave')
    .replace(/\b(road)\b/g, 'rd')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .replace(/\b(highway|hwy)\b/g, 'hwy')
    .replace(/\b(suite|ste|unit)\b.*$/, '')   // a suite is not a property
    .replace(/\s+/g, ' ')
    .trim();
  if (!street) return null;
  return `${street}|${String(city).toLowerCase().trim()}|${String(state).toUpperCase().trim()}`;
}

/**
 * Group parsed sources by property and merge each group.
 *
 * Sources with no usable address are each returned as their own listing rather
 * than being pooled into an "unknown" bucket — pooling them would merge two
 * unrelated properties into one record, which is worse than failing to dedupe.
 */
export function assembleListings(sources = []) {
  const groups = new Map();
  let orphan = 0;
  for (const s of sources) {
    const key = listingKey(s.fields || {}) || `__no-address-${orphan++}`;
    const list = groups.get(key) || [];
    list.push(s);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key: key.startsWith('__no-address-') ? null : key,
    ...mergeListing(group),
  }));
}
