'use strict';

const crypto = require('crypto');
const config = require('../config');
const { authPool } = require('../db/pool');
const envelope = require('../crypto/envelope');
const { DuoClient, DuoError } = require('./duo');

/**
 * The second factor's own state: the gap between "the identity provider said
 * who you are" and "you have a session".
 *
 * Everything needed to resume the login lives in the `mfa_pending` row. The
 * browser carries one opaque, single-use handle in a short-lived cookie and
 * nothing else — no user id, no tenant, no signed blob asserting either.
 *
 * That choice is the whole security argument for this file. A signed cookie
 * carrying the resolved identity across the Duo round trip is the conventional
 * design and it makes the entire second factor depend on one signature check
 * being right every time. A row in a table cannot be forged by getting a
 * verification subtly wrong; the worst an attacker can do with a stolen handle
 * is use it once, in the window it is alive, from a browser that also holds it.
 */

const NONCE_BYTES = 32;
const STATE_BYTES = 32;   // 43 base64url chars, inside Duo's 22–1024 range

const hash = (v) => crypto.createHash('sha256').update(v).digest();

/**
 * The key per-tenant Duo client secrets are sealed with.
 *
 * Throws when it is absent, and that refusal is the point: there is no code
 * path here that falls back to storing a client secret in the clear. A platform
 * without DUO_CONFIG_KEY simply cannot have Duo integrations, which is a
 * legible state; a platform that silently degrades to plaintext secrets is not.
 */
function duoKey() {
  const raw = config.duo.configKey;
  if (!raw) {
    throw new DuoError('no_config_key',
      'DUO_CONFIG_KEY is not set, so Duo client secrets cannot be sealed or opened');
  }
  // Accept either spelling an operator is likely to paste out of a secrets
  // manager. Length is checked against the cipher's requirement, not guessed.
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== envelope.KEY_BYTES) {
    throw new DuoError('bad_config_key',
      `DUO_CONFIG_KEY must decode to ${envelope.KEY_BYTES} bytes; got ${key.length}`);
  }
  return key;
}

/** Seal a client secret for storage. Used by the admin tooling only. */
function sealSecret(tenantId, clientSecret) {
  return envelope.seal(duoKey(), tenantId, Buffer.from(clientSecret, 'utf8'));
}

/**
 * The tenant's Duo configuration, or null when it has none.
 *
 * Reads on the AUTH pool: this is platform configuration consulted while
 * deciding whether a login may proceed, at a moment when the tenant-data role
 * has no business being involved.
 */
async function configFor(tenantId) {
  const { rows } = await authPool.query(
    `SELECT api_host, client_id, client_secret_ct, enabled, fail_mode, verified_at
       FROM tenant_duo WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row || !row.enabled) return null;
  return row;
}

/**
 * Build the client for a tenant, opening its sealed secret.
 *
 * The plaintext secret exists only inside the returned client, for the length
 * of one login. It is never logged, never returned, and never cached.
 */
function clientFor(tenantId, row) {
  const clientSecret = envelope.open(duoKey(), tenantId, row.client_secret_ct).toString('utf8');
  return new DuoClient({
    apiHost: row.api_host,
    clientId: row.client_id,
    clientSecret,
    redirectUri: config.duo.redirectUri,
  });
}

/**
 * Park the resolved login and return where to send the browser.
 *
 * Called after every identity check in login.complete() has passed and BEFORE
 * any session exists. If this throws, no session is issued — which is the
 * correct direction for a second factor to fail in.
 *
 * @returns {{url: string, nonce: string}} the Duo URL, and the handle to put in
 *   a short-lived httpOnly cookie.
 */
async function challenge({ tenantId, user, duoRow, redirectTo, ip, userAgent,
  authMethod, idpMfaAsserted }) {
  const client = clientFor(tenantId, duoRow);

  const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64url');
  const state = crypto.randomBytes(STATE_BYTES).toString('base64url');

  // The email address is what Duo knows people by, because it is what the
  // directory that enrolled them knows them by. Recorded on the row so the
  // callback can prove Duo's answer is about this person and not another.
  const username = user.email;

  await authPool.query(
    `INSERT INTO mfa_pending
       (nonce_hash, state_hash, tenant_id, user_id, duo_username, redirect_to,
        ip, user_agent, auth_method, idp_mfa_asserted, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' milliseconds')::interval)`,
    [hash(nonce), hash(state), tenantId, user.id, username, redirectTo || '/',
      ip || null, (userAgent || '').slice(0, 500), authMethod || null,
      idpMfaAsserted === undefined ? null : idpMfaAsserted,
      String(config.duo.pendingTtlMs)],
  );

  return { url: client.authUrl({ username, state }), nonce };
}

/**
 * Claim a pending challenge. Single-use, atomically.
 *
 * One statement, not a SELECT followed by an UPDATE: two concurrent callbacks
 * carrying the same state must not both win, and a check-then-act pair here is
 * a replay window of exactly the size of the gap between them. The same
 * reasoning — and the same shape — as consumeState() in login.js.
 *
 * The nonce is compared in SQL against its stored hash, so a caller holding a
 * valid state but not the cookie claims nothing. Both halves, or neither.
 */
async function consumePending(state, nonce) {
  if (typeof state !== 'string' || typeof nonce !== 'string') return null;
  const { rows } = await authPool.query(
    `UPDATE mfa_pending SET consumed_at = now()
      WHERE state_hash = $1
        AND nonce_hash = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, tenant_id, user_id, duo_username, redirect_to, ip, user_agent,
                auth_method, idp_mfa_asserted`,
    [hash(state), hash(nonce)],
  );
  // One answer for every cause — unknown, already used, expired, wrong browser.
  // Distinguishing them tells someone probing which of their guesses existed.
  return rows[0] || null;
}

/**
 * Remove expired and consumed challenges.
 *
 * Nothing in the login path reads a consumed row, so leaving them is a
 * correctness no-op and a retention problem: each carries an ip and a user
 * agent for a named person. Called by the retention job.
 */
async function purgeExpired({ olderThanHours = 24 } = {}) {
  const { rowCount } = await authPool.query(
    `DELETE FROM mfa_pending
      WHERE expires_at < now() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
  return rowCount;
}

module.exports = {
  duoKey, sealSecret, configFor, clientFor, challenge, consumePending, purgeExpired,
};
