'use strict';

const crypto = require('node:crypto');

/**
 * The sealed-blob format. Pure functions over buffers: no database, no key
 * management, nothing that needs an environment to be tested.
 *
 * AES-256-GCM, which is authenticated encryption — the tag is verified on open,
 * so a modified ciphertext fails loudly instead of decrypting to garbage that a
 * JSON parser might, on a bad day, accept.
 *
 * THE TENANT ID IS THE ADDITIONAL AUTHENTICATED DATA, and that is the point of
 * this file rather than an incidental hardening. Without it, a ciphertext
 * lifted out of one firm's row and pasted into another's — by anyone who
 * reaches the database, which is exactly the attacker envelope encryption
 * exists to stop — would decrypt cleanly under the target tenant's key if the
 * two firms ever shared a key, and more importantly would leave the read path
 * with no way to notice that a blob had moved. Binding the tenant id into the
 * tag means the copy fails to open. See crypto.test.js, which performs that
 * exact swap.
 *
 * The DEAL id is deliberately NOT bound in. It would stop a blob being moved
 * between two deals of the SAME firm, which is not a boundary: any analyst at
 * that firm can already copy a payload from one deal to another through the
 * API. Binding it would only make re-keying and backfill harder for no
 * confidentiality gain.
 */

// Bumped if the layout or cipher ever changes. It is written into the blob AND
// into the AAD, so a blob cannot be replayed as if it were a different version.
const VERSION = 1;

const IV_BYTES = 12;   // GCM's native nonce size; anything else forces a rehash
const TAG_BYTES = 16;
const KEY_BYTES = 32;  // AES-256

/** `crea` = CRE analyzer. Domain-separated so these bytes cannot be confused
 *  with any other AAD this codebase might one day construct. */
function additionalData(version, tenantId) {
  const id = String(tenantId || '').toLowerCase();
  if (!id) throw new Error('envelope: a tenant id is required as additional authenticated data');
  return Buffer.from(`crea-envelope-v${version}|tenant=${id}`, 'utf8');
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`envelope: key must be ${KEY_BYTES} bytes; got ${Buffer.isBuffer(key) ? key.length : typeof key}`);
  }
}

/**
 * @param {Buffer} key       32-byte data key
 * @param {string} tenantId  bound into the tag; see the note above
 * @param {Buffer} plaintext
 * @returns {Buffer} [version:1][iv:12][tag:16][ciphertext]
 */
function seal(key, tenantId, plaintext) {
  assertKey(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalData(VERSION, tenantId));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/**
 * Open a sealed blob, or throw. Never returns partial or unverified plaintext:
 * `decipher.final()` is what checks the tag, so it is always called before
 * anything is handed back.
 */
function open(key, tenantId, sealed) {
  assertKey(key);
  if (!Buffer.isBuffer(sealed) || sealed.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('envelope: sealed blob is truncated');
  }
  const version = sealed[0];
  if (version !== VERSION) {
    // Stated rather than attempted. A future version read by old code must fail
    // rather than be decrypted under the wrong assumptions about its layout.
    throw new Error(`envelope: unsupported version ${version}`);
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(1 + IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(additionalData(version, tenantId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

module.exports = { seal, open, VERSION, KEY_BYTES, IV_BYTES, TAG_BYTES };
