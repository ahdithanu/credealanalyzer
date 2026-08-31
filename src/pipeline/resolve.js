/**
 * Entity resolution.
 *
 * Deciding that "SUNBELT CAR WASH HOLDINGS LLC", "Sunbelt Carwash Holdings,
 * L.L.C." and "SUNBELT CARWASH HLDGS LLC" are one entity is the hardest and
 * most consequential step in the pipeline: every downstream ownership rollup,
 * portfolio view and related-party exclusion inherits its errors.
 *
 * Three stages, in this order:
 *
 *   normalise  strip the noise that legal naming conventions add
 *   block      generate candidate pairs cheaply, so we compare O(n·k)
 *              pairs instead of O(n²) — at county scale n is millions
 *   match      score each candidate, then classify into accept / review / reject
 *
 * The review band is not a failure mode, it is the design. Auto-merging the
 * uncertain middle is how you end up telling a committee that two unrelated
 * sponsors are the same firm.
 */

/** Legal suffixes carry no identity signal, but their PRESENCE does. */
const LEGAL_SUFFIXES = [
  'LLC', 'L L C', 'LC', 'LP', 'L P', 'LLP', 'LLLP', 'PLLC',
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY',
  'LTD', 'LIMITED', 'TRUST', 'TR', 'PARTNERSHIP', 'PARTNERS',
];

/** Abbreviations seen constantly on assessor rolls. */
const TOKEN_ALIASES = {
  HLDGS: 'HOLDINGS', HLDG: 'HOLDINGS', HOLDING: 'HOLDINGS',
  PROPS: 'PROPERTIES', PROP: 'PROPERTIES', PPTY: 'PROPERTIES', PPTYS: 'PROPERTIES',
  INVS: 'INVESTMENTS', INV: 'INVESTMENTS', INVEST: 'INVESTMENTS',
  MGMT: 'MANAGEMENT', MGT: 'MANAGEMENT',
  DEV: 'DEVELOPMENT', DEVL: 'DEVELOPMENT',
  RE: 'REALESTATE', ASSOC: 'ASSOCIATES', ASSOCS: 'ASSOCIATES',
  CARWASH: 'CAR WASH',
  ENTS: 'ENTERPRISES', ENT: 'ENTERPRISES',
  GRP: 'GROUP', PTNRS: 'PARTNERS', PTNR: 'PARTNERS',
};

const STREET_ALIASES = {
  STREET: 'ST', ROAD: 'RD', AVENUE: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR',
  LANE: 'LN', PARKWAY: 'PKWY', HIGHWAY: 'HWY', SUITE: 'STE', NORTH: 'N',
  SOUTH: 'S', EAST: 'E', WEST: 'W', FREEWAY: 'FWY',
};

/**
 * Normalise an entity name into a comparable core plus its legal suffix.
 * @returns {{core:string, tokens:string[], suffix:string|null, raw:string}}
 */
export function normalizeEntityName(raw) {
  const input = String(raw ?? '');
  let s = input
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[.,''`"()#]/g, ' ')
    .replace(/[-/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Pull off a trailing legal suffix, longest first so "L L C" beats "C".
  let suffix = null;
  for (const suf of [...LEGAL_SUFFIXES].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\s${suf}$`);
    if (re.test(s)) {
      suffix = suf.replace(/\s/g, '');
      s = s.replace(re, '').trim();
      break;
    }
  }

  const tokens = s.split(' ')
    .filter(Boolean)
    .flatMap((t) => (TOKEN_ALIASES[t] ?? t).split(' '));

  return { core: tokens.join(' '), tokens, suffix, raw: input };
}

/** Normalise a street address for use as a corroborating signal. */
export function normalizeAddress(raw) {
  if (!raw) return null;
  const s = String(raw).toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((t) => STREET_ALIASES[t] ?? t)
    .join(' ');
  return s || null;
}

/**
 * Blocking keys for a record. Any shared key makes a candidate pair.
 *
 * Several keys per record on purpose: a single key trades recall for speed, and
 * a missed pair is a silently wrong ownership rollup, which is worse than the
 * extra comparisons.
 */
export function blockingKeys(record) {
  const { core, tokens } = normalizeEntityName(record.name);
  const keys = new Set();
  if (core.length >= 4) keys.add(`P:${core.slice(0, 6)}`);            // prefix
  if (tokens.length) {
    keys.add(`T:${[...tokens].sort().slice(0, 2).join('|')}`);        // sorted head
    keys.add(`I:${tokens.map((t) => t[0]).join('')}`);                // initials
    keys.add(`F:${tokens.slice(0, 2).join('|')}`);                    // leading tokens:
    //   catches "SUNBELT CAR WASH HOLDINGS" against "SUNBELT CAR WASH", which
    //   every other key misses because the tail differs.
  }
  const addr = normalizeAddress(record.address);
  if (addr) keys.add(`A:${addr}`);
  return [...keys];
}

/**
 * A block larger than this carries almost no information — it is a common word,
 * not a signal — and comparing it costs O(n²) within the block. Real rolls are
 * full of them ("TEXAS ...", "HOUSTON ..."), so they are dropped and reported
 * rather than silently ground through.
 */
export const MAX_BLOCK_SIZE = 100;

/** Group records into candidate blocks. */
export function block(records) {
  const blocks = new Map();
  for (const r of records) {
    for (const k of blockingKeys(r)) {
      if (!blocks.has(k)) blocks.set(k, []);
      blocks.get(k).push(r);
    }
  }
  return blocks;
}

/** Unique unordered candidate pairs implied by the blocks. */
export function candidatePairs(records, { maxBlockSize = MAX_BLOCK_SIZE } = {}) {
  const seen = new Set();
  const pairs = [];
  for (const group of block(records).values()) {
    if (group.length < 2 || group.length > maxBlockSize) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = group[i].id < group[j].id ? [group[i], group[j]] : [group[j], group[i]];
        const key = `${a.id}::${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/**
 * Which blocks were too large to compare. Surfacing this matters: a dropped
 * block is unexamined recall, and an operator needs to see it to decide whether
 * a better key is needed for that name family.
 */
export function oversizedBlocks(records, { maxBlockSize = MAX_BLOCK_SIZE } = {}) {
  const out = [];
  for (const [key, group] of block(records).entries()) {
    if (group.length > maxBlockSize) out.push({ key, size: group.length });
  }
  return out.sort((a, b) => b.size - a.size);
}

const jaccard = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
};

export const MATCH_THRESHOLDS = { accept: 0.92, review: 0.72 };

/**
 * Score a candidate pair. Returns the score and the evidence behind it, because
 * a reviewer clearing the middle band needs to see why the machine hesitated.
 */
export function scorePair(a, b) {
  const na = normalizeEntityName(a.name);
  const nb = normalizeEntityName(b.name);
  const evidence = [];

  let score;
  if (na.core === nb.core && na.core.length > 0) {
    score = 0.95;
    evidence.push('normalised names are identical');
  } else {
    // Jaccard, unscaled. An arbitrary damping factor here pushed genuinely
    // similar pairs — "SUNBELT CAR WASH HOLDINGS" against "SUNBELT CAR WASH",
    // 75% overlap — below the review band and into silent rejection. A missed
    // relation is an ownership rollup that is quietly wrong, which is worse
    // than a reviewer spending ten seconds on a pair that turns out distinct.
    const overlap = jaccard(na.tokens, nb.tokens);
    score = overlap;
    evidence.push(`token overlap ${(overlap * 100).toFixed(0)}%`);
  }

  // A shared mailing address is strong corroboration — but registered-agent
  // addresses are shared by thousands of unrelated SPEs, so it lifts a decent
  // name match rather than carrying a weak one on its own.
  const aa = normalizeAddress(a.address);
  const ab = normalizeAddress(b.address);
  if (aa && ab && aa === ab) {
    score += 0.06;
    evidence.push('same mailing address');
  }

  // Different legal forms are usually different entities in the same family.
  if (na.suffix && nb.suffix && na.suffix !== nb.suffix) {
    score -= 0.08;
    evidence.push(`different legal form (${na.suffix} vs ${nb.suffix})`);
  }

  score = Math.max(0, Math.min(1, score));
  const decision = score >= MATCH_THRESHOLDS.accept ? 'accept'
    : score >= MATCH_THRESHOLDS.review ? 'review'
    : 'reject';

  return { a, b, score, decision, evidence };
}

/**
 * Resolve a record set into clusters.
 *
 * Accepted pairs are merged transitively via union-find; review pairs are
 * queued for a person and explicitly NOT merged.
 *
 * @returns {{clusters:Array, review:Array, stats:Object}}
 */
export function resolveEntities(records) {
  const parent = new Map(records.map((r) => [r.id, r.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx < ry ? ry : rx, rx < ry ? rx : ry);
  };

  const scored = candidatePairs(records).map(([a, b]) => scorePair(a, b));
  const review = [];
  let accepted = 0;

  for (const s of scored) {
    if (s.decision === 'accept') { union(s.a.id, s.b.id); accepted++; }
    else if (s.decision === 'review') {
      review.push({ aId: s.a.id, bId: s.b.id, aName: s.a.name, bName: s.b.name, score: s.score, evidence: s.evidence });
    }
  }

  const byRoot = new Map();
  for (const r of records) {
    const root = find(r.id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(r);
  }

  const clusters = [...byRoot.entries()].map(([root, members]) => ({
    id: `entity:${root}`,
    canonicalName: pickCanonicalName(members),
    members,
    memberIds: members.map((m) => m.id),
  }));

  review.sort((x, y) => y.score - x.score);

  return {
    clusters,
    review,
    stats: {
      records: records.length,
      candidatePairs: scored.length,
      accepted,
      queuedForReview: review.length,
      clusters: clusters.length,
      oversizedBlocks: oversizedBlocks(records),
    },
  };
}

/**
 * The surface form carrying the most information, then the least punctuation.
 * Ranking by raw string length is wrong: "Sunbelt Car Wash Holdings, L.L.C." is
 * longer than "SUNBELT CAR WASH HOLDINGS LLC" purely because of its full stops.
 */
function pickCanonicalName(members) {
  const rank = (name) => {
    const n = normalizeEntityName(name);
    const punctuation = (name.match(/[.,''`"()#\-/\\]/g) ?? []).length;
    return { tokens: n.tokens.length + (n.suffix ? 1 : 0), punctuation, length: name.length };
  };
  return members
    .map((m) => ({ name: m.name, ...rank(m.name) }))
    .sort((a, b) =>
      b.tokens - a.tokens ||
      a.punctuation - b.punctuation ||
      b.length - a.length ||
      a.name.localeCompare(b.name))[0].name;
}
