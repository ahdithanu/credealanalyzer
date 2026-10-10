'use strict';

const crypto = require('node:crypto');
const envelope = require('./envelope');
const { keyProvider } = require('./keyProvider');

/**
 * The tenant key lifecycle, and the only sanctioned way to read or write a deal
 * payload.
 *
 * Every function here takes the `db` handle from inside withTenant(), so the
 * key row it reads is scoped by the same row level security as the deals it
 * unlocks. There is no path that fetches a key for a tenant other than the one
 * the transaction is running as — not because this module is careful, but
 * because the policy in migration 005 would return nothing if it tried.
 */

/**
 * How long an UNWRAPPED data key may be reused inside one process.
 *
 * Unwrapping per read means a KMS call per read: latency on every deal list and
 * a bill that scales with page views. So the plaintext key is cached — but
 * keyed by a DIGEST OF THE WRAPPED BLOB, not by tenant id, and that detail is
 * what makes the cache safe rather than merely fast:
 *
 *   - The wrapped key row is still SELECTed every time, on the connection the
 *     caller already holds. Only the remote unwrap is skipped. So a key that
 *     has been DESTROYED stops working immediately: the row's wrapped_key is
 *     NULL and this throws before the cache is ever consulted. A cache keyed by
 *     tenant id would have kept serving the destroyed key for the whole TTL,
 *     which would make the erasure claim in admin/retention.js false for as
 *     long as any process stayed warm.
 *   - A transaction that creates a key and then rolls back leaves a cache entry
 *     whose wrapped blob no longer exists anywhere, so it can never be matched
 *     and returned for the key that replaces it. Keyed by tenant id, that
 *     rollback would have poisoned the process into encrypting under a key the
 *     database does not have — silent, permanent data loss.
 */
const CACHE_TTL_MS = Number(process.env.TENANT_KEY_CACHE_MS || 5 * 60 * 1000);

const cache = new Map();

/** Raised when the tenant's key has been deliberately destroyed. Distinct from
 *  every other failure: the data is not coming back, and no retry will help. */
class KeyDestroyedError extends Error {
  constructor(tenantId) {
    super(`the data key for tenant ${tenantId} has been destroyed`);
    this.name = 'KeyDestroyedError';
    this.code = 'key_destroyed';
  }
}

const cacheKey = (tenantId, wrapped) => `${tenantId}:${
  crypto.createHash('sha256').update(wrapped).digest('hex')}`;

async function unwrapCached(provider, tenantId, wrapped) {
  const k = cacheKey(tenantId, wrapped);
  const hit = cache.get(k);
  if (hit && hit.expiresAt > Date.now()) return hit.key;
  cache.delete(k);
  const key = await provider.unwrapDataKey(tenantId, wrapped);
  cache.set(k, { key, expiresAt: Date.now() + CACHE_TTL_MS });
  return key;
}

/** The tenant's plaintext data key, creating one on first use. */
async function tenantDataKey(db, tenantId) {
  const provider = keyProvider();
  const select = () => db.query(
    'SELECT wrapped_key, provider, destroyed_at FROM tenant_keys WHERE tenant_id = $1',
    [tenantId],
  ).then((q) => q.rows[0] || null);

  // The common case — the key exists — takes NO LOCK. An advisory lock is held
  // until the transaction ends, so taking one here would serialise every deal
  // list for a tenant behind every other one: a correctness fix that becomes a
  // throughput bug the moment two analysts at the same firm hit refresh.
  let row = await select();
  if (!row) {
    // Creation only. Two requests from a brand-new firm arriving together would
    // both find no key and both try to create one; under READ COMMITTED the
    // loser cannot see the winner's uncommitted row, so it would fail on the
    // primary key. The lock makes the second wait and then see the committed
    // row, because READ COMMITTED takes a fresh snapshot for each statement.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1), 1)', [`tenant_key:${tenantId}`]);
    row = await select();
  }

  if (row) {
    if (row.destroyed_at) throw new KeyDestroyedError(tenantId);
    if (row.provider !== provider.name) {
      // Not attempted. Unwrapping a KMS blob with the local master (or the
      // reverse) produces an authentication failure that reads like corrupt
      // data; naming the mismatch is the difference between a five-minute fix
      // and a day of suspecting the database.
      throw new Error(
        `tenant ${tenantId} key was wrapped by provider '${row.provider}' but this process is configured for '${provider.name}'`,
      );
    }
    return unwrapCached(provider, tenantId, Buffer.from(row.wrapped_key));
  }

  const fresh = await provider.generateDataKey(tenantId);
  await db.query(
    `INSERT INTO tenant_keys (tenant_id, provider, master_key_ref, wrapped_key)
     VALUES ($1,$2,$3,$4)`,
    [tenantId, provider.name, provider.masterKeyRef, fresh.wrapped],
  );
  cache.set(cacheKey(tenantId, fresh.wrapped),
    { key: fresh.plaintext, expiresAt: Date.now() + CACHE_TTL_MS });
  return fresh.plaintext;
}

/**
 * Serialise and seal a payload for storage in `deals.payload_ct`.
 *
 * @returns {Promise<Buffer>} the sealed blob. The caller writes it to the bytea
 *   column and writes NULL to `payload`; migration 005's check constraint
 *   refuses the row if it forgets.
 */
async function sealPayload(db, tenantId, payload) {
  const key = await tenantDataKey(db, tenantId);
  return envelope.seal(key, tenantId, Buffer.from(JSON.stringify(payload), 'utf8'));
}

/**
 * Turn one stored row into `{ payload, payloadError }`, given a key already
 * fetched. Synchronous and DB-free so a caller iterating five hundred rows
 * pays for the key once.
 *
 * TRANSITIONAL BY DESIGN. Rows written before migration 005 are plaintext jsonb
 * and rows written after are ciphertext; both are readable here so that
 * deploying the encryption does not require a backfill to have finished first.
 * src/crypto/backfill.js converts the old ones once, and the check constraint
 * guarantees a row is never both.
 *
 * It NEVER returns the ciphertext, and on failure returns null with an explicit
 * reason rather than throwing. A single unreadable row must not take out a whole
 * list — or, worse, a whole export — and a caller that gets null alongside a
 * reason can say "this payload is unavailable" instead of "this deal has no
 * assumptions", which is a different and much more dangerous claim.
 */
function readPayload(tenantId, row, key, keyError) {
  if (row.payload_ct != null) {
    if (!key) return { payload: null, payloadError: keyError || 'key_unavailable' };
    try {
      const plain = envelope.open(key, tenantId, Buffer.from(row.payload_ct));
      return { payload: JSON.parse(plain.toString('utf8')) };
    } catch {
      return { payload: null, payloadError: 'decrypt_failed' };
    }
  }
  if (row.payload != null) return { payload: row.payload };
  // Unknown, and said so. Never `{}` — an empty underwriting model is a claim
  // that the deal has no assumptions, and this function has no idea whether
  // that is true.
  return { payload: null, payloadError: 'missing' };
}

/** Fetch the tenant key only if some row actually needs it, and never let a key
 *  failure throw: it becomes a per-row reason instead. */
async function keyFor(db, tenantId, rows) {
  if (!rows.some((r) => r.payload_ct != null)) return { key: null, keyError: null };
  try {
    return { key: await tenantDataKey(db, tenantId), keyError: null };
  } catch (err) {
    return { key: null, keyError: err.code === 'key_destroyed' ? 'key_destroyed' : 'key_unavailable' };
  }
}

/**
 * Project stored rows for an API response: the payload in place of the two
 * storage columns, and `payloadError` only when there is one.
 *
 * Centralised so no route assembles this by hand — the route that forgets to
 * delete `payload_ct` from the object is the route that ships ciphertext to a
 * browser.
 */
async function presentDeals(db, tenantId, rows) {
  const { key, keyError } = await keyFor(db, tenantId, rows);
  return rows.map((row) => {
    const { payload, payloadError } = readPayload(tenantId, row, key, keyError);
    const out = {
      id: row.id,
      name: row.name,
      stage: row.stage,
      payload,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (payloadError) out.payloadError = payloadError;
    return out;
  });
}

async function presentDeal(db, tenantId, row) {
  return (await presentDeals(db, tenantId, [row]))[0];
}

/** Read a single row's payload without the API projection — for the export,
 *  which carries its own shape. */
async function openPayload(db, tenantId, row) {
  const { key, keyError } = await keyFor(db, tenantId, [row]);
  return readPayload(tenantId, row, key, keyError);
}

/** Tests only, and the backfill between tenants: drop unwrapped keys. */
function __clearKeyCache() { cache.clear(); }

module.exports = {
  tenantDataKey, sealPayload, openPayload, readPayload, keyFor,
  presentDeal, presentDeals, KeyDestroyedError, __clearKeyCache, CACHE_TTL_MS,
};
