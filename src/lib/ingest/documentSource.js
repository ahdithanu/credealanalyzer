/**
 * An uploaded document's extraction, as listing sources for listing.js.
 *
 * Inputs are the three contracts: a C1 document, its C2 predictions and its
 * C4 review state. Output is what observe()/mergeListing() take:
 * { sourceKind, sourceName, asOf, fields }.
 *
 * THE DECISION: reviewed and unreviewed values are different sources at
 * different trust tiers, never one source with a flag that merge drops.
 *
 *   reviewed    'confirmed' and 'edited' values. Tier 'document': a person has
 *               checked them against the seller's offering memorandum or
 *               filing, which is what listing.js means by a document.
 *   unreviewed  'pending' values, ONLY when the caller asks for them. Tier
 *               'estimate', which listing.js defines as "a house default or a
 *               model output", and an unchecked extraction is exactly a model
 *               output. Its sourceName says "unreviewed" so that every
 *               provenance entry and conflict row naming it says so too:
 *               listing.js carries sourceName and sourceKind through and
 *               nothing else, so the mark has to live there.
 *   rejected    never a source.
 *
 * The review screen asks for unreviewed values so it can show a conflict
 * before the reviewer decides; anything that feeds a deal must not.
 *
 * asOf is left null. C1's createdAt is when the file was uploaded, and
 * listing.js's asOf is the date the source DESCRIBES; using one for the other
 * would let an old memorandum outrank a newer one because it was uploaded
 * later.
 */

/**
 * Extraction field name to listing.js field name, for the fields listing.js
 * understands: address (it keys deduplication on it), buildingSize and
 * occupancyPct (it carries expected-divergence notes for both), purchasePrice
 * and yearBuilt (fields its own sources use).
 *
 * squareFeet becomes buildingSize; occupancy (percent points) becomes
 * occupancyPct (percent points).
 */
export const LISTING_FIELD_MAP = {
  address: 'address',
  squareFeet: 'buildingSize',
  yearBuilt: 'yearBuilt',
  purchasePrice: 'purchasePrice',
  occupancy: 'occupancyPct',
};

/**
 * Extraction fields deliberately NOT mapped, with why. Any other field (the
 * draft PRODUCT_FIELDS) is unmapped too and reported by unmappedFields().
 */
export const UNMAPPED_REASONS = {
  propertyType: 'listing.js has no property-type field; the deal carries its own.',
  netOperatingIncome: 'listing.js has no income field; NOI belongs to the deal model, not the listing.',
  capRate: 'listing.js has no cap rate field; a stated cap rate is derived from price and NOI.',
};

export const UNREVIEWED_SUFFIX = ' (unreviewed extraction)';

function nameOf(document) {
  if (document?.filename) return document.filename;
  if (document?.id !== undefined && document?.id !== null) return `document ${document.id}`;
  return 'uploaded document';
}

function mapFields(values) {
  const fields = {};
  for (const [name, value] of Object.entries(values)) {
    const target = LISTING_FIELD_MAP[name];
    if (!target) continue;
    if (value === null || value === undefined || value === '') continue;
    fields[target] = value;
  }
  return fields;
}

/** Extraction field names that have a value but no listing field. */
export function unmappedFields(predictions = {}, review = {}) {
  const names = new Set([...Object.keys(predictions || {}), ...Object.keys(review || {})]);
  return [...names].filter((n) => !LISTING_FIELD_MAP[n]).sort();
}

/** The reviewed source: confirmed and edited values only, tier 'document'. */
export function documentSource(document, review = {}) {
  const values = {};
  for (const [name, e] of Object.entries(review || {})) {
    if (e && (e.status === 'confirmed' || e.status === 'edited')) values[name] = e.value;
  }
  return {
    sourceKind: 'document',
    sourceName: nameOf(document),
    asOf: null,
    fields: mapFields(values),
  };
}

/**
 * The unreviewed source: pending values, tier 'estimate'. A predicted field
 * with no review entry at all counts as pending.
 */
export function unreviewedSource(document, predictions = {}, review = {}) {
  const values = {};
  for (const [name, p] of Object.entries(predictions || {})) {
    const e = review?.[name];
    const status = e ? e.status : 'pending';
    if (status !== 'pending') continue;
    values[name] = e ? e.value : p?.value;
  }
  return {
    sourceKind: 'estimate',
    sourceName: `${nameOf(document)}${UNREVIEWED_SUFFIX}`,
    asOf: null,
    fields: mapFields(values),
  };
}

/**
 * The sources this document contributes to a listing. Empty sources are left
 * out so mergeListing's source list does not claim a document said nothing.
 *
 * @param {{includeUnreviewed?: boolean}} [opts]  default false: deal inputs
 *   and anything downstream of the listing must never see pending values.
 */
export function listingSources(document, predictions, review, { includeUnreviewed = false } = {}) {
  const out = [documentSource(document, review)];
  if (includeUnreviewed) out.push(unreviewedSource(document, predictions, review));
  return out.filter((s) => Object.keys(s.fields).length > 0);
}

/** True when a listing source name marks unreviewed values. */
export function isUnreviewedSourceName(name) {
  return typeof name === 'string' && name.endsWith(UNREVIEWED_SUFFIX);
}
