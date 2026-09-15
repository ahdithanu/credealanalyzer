'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const envelope = require('./envelope');

/**
 * The master-key boundary, behind an interface with two implementations.
 *
 * WHY AN INTERFACE AT ALL. The production answer is AWS KMS: the master key
 * never leaves the HSM, every use is logged in CloudTrail, and destroying it is
 * a thing AWS will do and attest to. None of that is available to `npm test` or
 * to `docker compose up`, and a test suite that needs a real KMS key is a test
 * suite that does not run — which is how encryption ends up untested. So there
 * are two providers and one interface, and the tests exercise the same envelope
 * code path production does.
 *
 * WHY THE LOCAL ONE CANNOT BE SELECTED IN PRODUCTION. Exactly the pattern
 * src/config.js already applies to SSO_PROVIDER=stub: the stub login provider
 * is a test fixture, so booting with it in production throws rather than
 * quietly running a fake identity provider against real customers. The same
 * reasoning applies with more force here — a local master key derived from an
 * environment variable is a key that lives in a process listing, a task
 * definition and a memory dump, and "we encrypt deal payloads with a key held
 * in an env var" is not the claim the encryption is sold on. Refused at
 * construction, below, where it cannot be overridden by a flag.
 */

class KeyProvider {
  /** Stored on each tenant key row, so a wrapped key records who wrapped it. */
  // eslint-disable-next-line class-methods-use-this
  get name() { throw new Error('KeyProvider.name is not implemented'); }

  /**
   * A non-secret identifier for the master key in use. Recorded alongside every
   * wrapped key so that "this key was wrapped by a master we no longer have" is
   * a diagnosable condition rather than a decryption failure with no
   * explanation.
   */
  // eslint-disable-next-line class-methods-use-this
  get masterKeyRef() { throw new Error('KeyProvider.masterKeyRef is not implemented'); }

  /** @returns {Promise<{plaintext: Buffer, wrapped: Buffer}>} a fresh 32-byte data key. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async generateDataKey(tenantId) { throw new Error('KeyProvider.generateDataKey is not implemented'); }

  async unwrapDataKey(tenantId, wrapped) { throw new Error('KeyProvider.unwrapDataKey is not implemented'); }

  /**
   * Whether destroying a tenant's key makes its ciphertext unrecoverable
   * EVERYWHERE — including in database snapshots, the WAL archive and replicas.
   *
   * This exists because the obvious erasure story is false by default and was
   * shipped false: the wrapped data key lives in the same Postgres database as
   * the ciphertext it opens, so every snapshot contains both. Nulling the
   * wrapped key in the live row leaves last night's backup fully recoverable by
   * anyone holding the still-live master key — a verifier reproduced exactly
   * that, recovering a "shredded" payload from a restored dump.
   *
   * Only a provider that can destroy key material OUTSIDE the database can make
   * the stronger claim, so each one states which it is and the CLI reports what
   * was actually achieved rather than asserting the stronger guarantee.
   */
  get shreddingReachesBackups() { return false; }

  /**
   * Destroy key material held outside the database. A no-op where there is
   * none. Returns what was done, for the audit entry.
   */
  async destroyTenantKeyMaterial(tenantId) { return { destroyed: false, reason: 'not-supported' }; }
}

// ─── Local ───────────────────────────────────────────────────────────────────

/**
 * Tests and compose. The master key is DERIVED from an environment variable
 * rather than used raw, so that a short or low-entropy value produces a
 * correctly sized key instead of an AES error that reads like a bug — and so
 * the variable's bytes are never themselves the key.
 */
class LocalKeyProvider extends KeyProvider {
  /**
   * FALSE, and the reason is structural rather than an oversight. Every
   * tenant's data key is derived by HKDF from one LOCAL_MASTER_KEY held in an
   * environment variable: there is no per-tenant material to destroy, and the
   * master belongs to the platform, so a snapshot plus that variable
   * reconstructs any tenant's key. Local exists for tests and the compose demo
   * and is refused in production by createKeyProvider().
   */
  get shreddingReachesBackups() { return false; }

  constructor(secret) {
    super();
    // Same shape as config.js's secret(): a fixed dev-only value when the
    // variable is absent outside production, so a fresh clone runs. It is
    // deliberately recognisable in a dump; nothing about it is a secret.
    const material = secret
      || process.env.LOCAL_MASTER_KEY
      || 'dev-only-insecure-master-key-not-for-production-use';
    // HKDF with a fixed, non-secret info string. The salt is empty on purpose:
    // there is nowhere to persist a random salt that a second process would
    // read, and an unrecoverable master key is a total data loss, not a
    // hardening.
    this._master = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.alloc(0),
        Buffer.from('crea-tenant-master-v1', 'utf8'), envelope.KEY_BYTES),
    );
    // A truncated digest of the derived key, not of the secret. Enough to tell
    // two masters apart in a key row; far too little to attack the key with.
    this._ref = `local:${crypto.createHash('sha256').update(this._master).digest('hex').slice(0, 16)}`;
  }

  get name() { return 'local'; }

  get masterKeyRef() { return this._ref; }

  async generateDataKey(tenantId) {
    const plaintext = crypto.randomBytes(envelope.KEY_BYTES);
    return { plaintext, wrapped: envelope.seal(this._master, tenantId, plaintext) };
  }

  async unwrapDataKey(tenantId, wrapped) {
    // The tenant id is the AAD here too, so a wrapped key row copied between
    // tenants fails to unwrap — the same defence one level up.
    return envelope.open(this._master, tenantId, Buffer.from(wrapped));
  }
}

// ─── AWS KMS ─────────────────────────────────────────────────────────────────

/**
 * Production. The data key is generated BY KMS (GenerateDataKey) rather than
 * locally and then encrypted, so the plaintext key exists in this process only
 * for the life of the request that needed it, and never in a form KMS did not
 * issue.
 *
 * EncryptionContext is KMS's additional authenticated data. It carries the
 * tenant id for the same reason envelope.js does: a wrapped key blob moved
 * between tenant rows fails to decrypt, and — the part only KMS can give — the
 * tenant id appears in the CloudTrail record of every single unwrap, so "which
 * firms' data was accessed during the incident window" is answerable from logs
 * we do not host.
 */
class AwsKmsKeyProvider extends KeyProvider {
  /**
   * TRUE only with a customer master key PER TENANT, because only then does
   * ScheduleKeyDeletion destroy material AWS holds and leave no copy of the
   * database — live, snapshot or replica — that can be opened again.
   *
   * With one shared CMK it is false, and saying so is the entire point: the
   * shared deployment is cheaper and perfectly reasonable, and it cannot
   * support an erasure claim about backups, so it must not make one.
   */
  get shreddingReachesBackups() { return this._perTenantKeys; }

  /**
   * Schedule the tenant's CMK for deletion.
   *
   * AWS enforces a 7-30 day waiting period that cannot be shortened. That is a
   * real caveat on an erasure commitment, so the date is returned rather than
   * smoothed over: the erasure is COMMITTED on the day it is requested and
   * COMPLETE on a later one, and the record should show both.
   */
  async destroyTenantKeyMaterial(tenantId) {
    if (!this._perTenantKeys) return { destroyed: false, reason: 'shared-cmk' };
    const client = this._kms();
    const { ScheduleKeyDeletionCommand } = this._commands();
    const keyId = this._tenantKeyId(tenantId);
    const out = await client.send(new ScheduleKeyDeletionCommand({
      KeyId: keyId,
      PendingWindowInDays: Number(process.env.KMS_PENDING_DELETION_DAYS || 7),
    }));
    return {
      destroyed: true,
      reason: 'cmk-scheduled-for-deletion',
      keyId,
      effectiveAt: out && out.DeletionDate ? new Date(out.DeletionDate).toISOString() : null,
    };
  }

  constructor(keyId, { client, perTenantKeys } = {}) {
    super();
    if (!keyId) throw new Error('KMS_KEY_ID is required when the key provider is aws-kms');
    this._keyId = keyId;
    this._client = client || null;
    // Per-tenant customer master keys, addressed by alias. Off by default
    // because it is a real operational cost (a CMK per tenant, each billed) and
    // because turning it on silently would change what `offboard` is entitled
    // to claim without anyone deciding to.
    this._perTenantKeys = perTenantKeys !== undefined
      ? Boolean(perTenantKeys)
      : process.env.KMS_PER_TENANT_KEYS === 'true';
    this._aliasPrefix = process.env.KMS_TENANT_ALIAS_PREFIX || 'alias/cre-tenant-';
  }

  /** The CMK for a tenant: its own alias when per-tenant keys are on. */
  _tenantKeyId(tenantId) {
    return this._perTenantKeys ? `${this._aliasPrefix}${tenantId}` : this._keyId;
  }

  async _clientOrThrow() { return this._kms(); }

  get name() { return 'aws-kms'; }

  get masterKeyRef() { return `aws-kms:${this._keyId}`; }

  /** Lazy, and optional in the same way db/iamAuth.js loads the RDS signer: a
   *  local run and the test suite never install the SDK, and must not have to. */
  _kms() {
    if (this._client) return this._client;
    let sdk;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      sdk = require('@aws-sdk/client-kms');
    } catch {
      // Loud, not a fallback. A task configured for KMS that cannot load the
      // SDK must refuse to serve rather than reach for some other key.
      throw new Error('KEY_PROVIDER=aws-kms but @aws-sdk/client-kms is not installed');
    }
    this._sdk = sdk;
    this._client = new sdk.KMSClient({ region: process.env.AWS_REGION });
    return this._client;
  }

  _commands() {
    this._kms();
    // eslint-disable-next-line global-require, import/no-unresolved
    return this._sdk || require('@aws-sdk/client-kms');
  }

  async generateDataKey(tenantId) {
    const { GenerateDataKeyCommand } = this._commands();
    const out = await this._kms().send(new GenerateDataKeyCommand({
      KeyId: this._tenantKeyId(tenantId),
      KeySpec: 'AES_256',
      EncryptionContext: { tenant_id: String(tenantId) },
    }));
    return { plaintext: Buffer.from(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob) };
  }

  async unwrapDataKey(tenantId, wrapped) {
    const { DecryptCommand } = this._commands();
    const out = await this._kms().send(new DecryptCommand({
      CiphertextBlob: Buffer.from(wrapped),
      EncryptionContext: { tenant_id: String(tenantId) },
      // Naming the key means KMS will not silently decrypt under whatever key
      // the blob claims it was made with.
      KeyId: this._tenantKeyId(tenantId),
    }));
    return Buffer.from(out.Plaintext);
  }
}

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * Build the configured provider.
 *
 * The default follows environment, not a flag, for the same reason db/pool.js
 * chooses IAM by the presence of DB_HOST: there is no mode to set wrongly. A
 * production task with no KEY_PROVIDER gets KMS and fails to start without a
 * key id, rather than falling back to something that works.
 */
function createKeyProvider(env = process.env) {
  const kind = env.KEY_PROVIDER || (config.isProd ? 'aws-kms' : 'local');

  if (config.isProd && kind === 'local') {
    throw new Error('KEY_PROVIDER=local is a test fixture and must never run in production');
  }
  if (kind === 'local') return new LocalKeyProvider(env.LOCAL_MASTER_KEY);
  if (kind === 'aws-kms') return new AwsKmsKeyProvider(env.KMS_KEY_ID);
  throw new Error(`unknown KEY_PROVIDER: ${kind}`);
}

let singleton = null;

/** The process-wide provider. Built once; a provider holds a client, not state. */
function keyProvider() {
  if (!singleton) singleton = createKeyProvider();
  return singleton;
}

/** Tests only: drop the memoised provider so a different environment applies. */
function __resetKeyProvider() { singleton = null; }

module.exports = {
  KeyProvider, LocalKeyProvider, AwsKmsKeyProvider,
  createKeyProvider, keyProvider, __resetKeyProvider,
};
