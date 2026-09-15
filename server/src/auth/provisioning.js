'use strict';

const crypto = require('crypto');
const { Client } = require('pg');
const { authPool } = require('../db/pool');

/**
 * SCIM credentials: minting them, and proving one.
 *
 * A SCIM token is not a session. It belongs to a machine, it is configured once
 * in a directory's admin screen and then sits there for years, nobody is
 * watching the browser it came from, and it can enumerate and deactivate every
 * user in a tenant. Treated like a session it would be the weakest credential
 * in the system; treated properly it is the one with the strongest storage
 * rules, which is what this file implements.
 *
 * THREE RULES, each defending against a specific thing:
 *
 *   1. Only a HASH is stored, exactly as in auth/session.js. A leaked database
 *      dump — a backup, an over-broad support query, a restored snapshot on a
 *      developer's laptop — must not contain a credential anyone can present.
 *
 *   2. THE TOKEN DETERMINES THE TENANT. Not a header, not a path parameter, not
 *      a field in the body, not a subdomain. This is the same rule as the one at
 *      the top of auth/session.js and it is the same rule for the same reason:
 *      row level security faithfully isolates whichever tenant it was told, and
 *      anything the caller can set is a tenant the caller chose.
 *
 *   3. ISSUANCE IS NOT AN HTTP ROUTE. It runs as an operator CLI against the
 *      OWNER credential the API never holds, for the same reason tenant
 *      onboarding does in src/admin/tenants.js: an internet-reachable endpoint
 *      that can mint a credential able to delete every user in a firm is an
 *      endpoint that, if it is ever broken, does exactly that. It happens a
 *      handful of times per customer, by a person, and it should leave a record.
 *
 * The CLI lives in this file rather than beside the other operator tools so
 * that minting and verifying a token cannot drift apart: both halves read the
 * one derivation below. A second file repeating that derivation is a second
 * file that can be changed alone, and the failure mode — tokens that verify
 * against the wrong hash — is discovered in production during a sync outage.
 *
 * Usage (DATABASE_MIGRATION_URL is the owner credential from Secrets Manager):
 *   node src/auth/provisioning.js issue --slug firm-x --name "Okta prod" --expires-days 365
 *   node src/auth/provisioning.js issue --slug firm-x --name "Okta prod" --no-expiry
 *   node src/auth/provisioning.js list [--slug firm-x]
 *   node src/auth/provisioning.js revoke --token-id <id>
 *   node src/auth/provisioning.js revoke-all --slug firm-x
 */

// 32 bytes of CSPRNG in the secret half. The id half only has to be unique
// among tokens, not unguessable — it is public by design.
const SECRET_BYTES = 32;
const ID_BYTES = 9;

/**
 * `scim_` is a recognisable prefix so that secret scanners, log scrubbers and a
 * human reading a support ticket can tell at a glance that a string pasted into
 * a chat window is a live credential and not an identifier.
 */
const PREFIX = 'scim_';
const TOKEN_RE = /^scim_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;

/**
 * The digest covers the WHOLE token, id and secret together, so a secret cannot
 * be lifted from one row and replayed against another id.
 */
const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest();

/**
 * A hash of nothing in particular, compared against when no token row was
 * found. Without it, an unknown token id returns before any comparison happens
 * and a known one does not, which is a timing oracle for enumerating which ids
 * exist — and an id is half of a credential.
 */
const ABSENT = crypto.createHash('sha256').update('scim:no-such-token').digest();

/**
 * Constant-time compare, so a near miss cannot be walked in by timing.
 *
 * Anything that is not a non-empty buffer is NOT A MATCH, and that is the
 * interesting case rather than a formality: coercing a missing value to an
 * empty buffer makes two absent hashes compare EQUAL, so a row with no digest
 * and a caller who presented nothing would authenticate each other.
 * timingSafeEqual also throws on a length mismatch, which would turn a short
 * token into a 500 and a distinguishable answer.
 */
function safeEqualBytes(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Split a presented token, or null if it is not even the right shape. */
function parseToken(presented) {
  if (typeof presented !== 'string') return null;
  const m = TOKEN_RE.exec(presented);
  return m ? { tokenId: m[1] } : null;
}

/**
 * Pull the credential out of an Authorization header.
 *
 * Only `Bearer`. Accepting other schemes, or a token in a query string, means
 * the credential ends up in an access log or a referer header.
 */
function bearerToken(header) {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const space = raw.indexOf(' ');
  if (space < 0) return null;
  if (raw.slice(0, space).toLowerCase() !== 'bearer') return null;
  return raw.slice(space + 1).trim() || null;
}

/**
 * Resolve a presented token to the tenant it belongs to, or null.
 *
 * Every failure returns the same null: unknown id, wrong secret, revoked,
 * expired, suspended tenant. The caller turns that into one 401 with one body.
 * Distinguishing them would tell an attacker which of their guesses was a real
 * token id, or that a tenant exists and is merely suspended.
 *
 * Runs on the AUTH pool. app_user has no grant on `scim_tokens` at all, so the
 * tenant-data path cannot read or forge a SCIM credential even by mistake —
 * the same split as `sessions` in migration 002.
 */
async function authenticate(authorizationHeader) {
  const presented = bearerToken(authorizationHeader);
  const parsed = parseToken(presented);
  if (!parsed) {
    // Still compare, so a malformed token is not measurably faster than a
    // well-formed one that does not exist.
    safeEqualBytes(ABSENT, ABSENT);
    return null;
  }

  // Selected by the PUBLIC half. No secret value appears in this statement, so
  // a slow-query log, a query plan or pg_stat_statements never holds one.
  const { rows } = await authPool.query(
    `SELECT k.token_id, k.tenant_id, k.token_hash, k.name, k.revoked_at, k.expires_at,
            t.slug AS tenant_slug, t.status AS tenant_status
       FROM scim_tokens k
       JOIN tenants t ON t.id = k.tenant_id
      WHERE k.token_id = $1`,
    [parsed.tokenId],
  );
  const row = rows[0];
  const matches = safeEqualBytes(row ? row.token_hash : ABSENT, hashToken(presented));
  if (!row || !matches) return null;

  // Revocation must bite on the very next request — that is the whole point of
  // storing the credential server-side rather than signing a self-contained one.
  if (row.revoked_at) return null;
  // NULL expires_at means no expiry. It is a recorded decision, not a default:
  // the CLI below refuses to issue a token without one answer or the other.
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;
  // A suspended tenant loses its directory sync at the same moment it loses its
  // people, without anyone having to remember to revoke each token.
  if (row.tenant_status !== 'active') return null;

  // Best effort, and not awaited: this is how an operator answers "is this
  // token still in use before I revoke it", and a failed write costs that
  // question a stale answer, never a wrong authentication decision.
  authPool.query('UPDATE scim_tokens SET last_used_at = now() WHERE token_id = $1', [row.token_id])
    .catch(() => { /* see above: precision, not correctness */ });

  return {
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    tokenId: row.token_id,
    tokenName: row.name,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in ONE transaction on the AUTH pool with the tenant established.
 *
 * The twin of withTenant() in db/pool.js, and it exists for one reason:
 * deprovisioning updates `users` AND revokes in `sessions`, and since migration
 * 002 no single role could touch both. Two pools would be two transactions, and
 * a deprovisioning that marks the account inactive but fails before revoking
 * the session has left the analyst holding exactly the access it was run to
 * remove. See the note at the top of migrations/007_scim_provisioning.sql for
 * why the authentication role is the one that grew — by a single command —
 * rather than the tenant-data role.
 *
 * Creating a user does NOT come through here: that is ordinary provisioning on
 * the tenant path under app_user, and a person who does not exist yet has no
 * session to revoke.
 *
 * `set_config(..., true)` is the LOCAL form, so the tenant is gone when the
 * transaction ends and cannot outlive the request on a pooled connection. The
 * tenant id is a BOUND PARAMETER, never interpolated.
 *
 * @param {string} tenantId  Resolved from the TOKEN by authenticate(). Never
 *   from a header, a path parameter or the body.
 */
async function withScimTenant(tenantId, fn) {
  if (!UUID.test(String(tenantId || ''))) {
    throw new Error('withScimTenant: tenantId must be a uuid');
  }
  const client = await authPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    // There is no acting user: the actor is a directory. Recorded as such in
    // the audit log via actor_kind, rather than attributed to whichever human
    // last happened to touch the account.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user', '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Append a SCIM action to the audit trail, INSIDE the caller's transaction.
 *
 * Deliberately NOT best-effort, which is the opposite of recordAdmin() in
 * src/admin/tenants.js — and the difference is the caller, not a change of
 * heart. There, a person has just performed an operation and believes it
 * succeeded; rolling it back because the audit write failed would leave them
 * with a half-applied action and no way to know. Here the caller is a directory
 * that retries on failure and shows its administrator a sync error, so refusing
 * to make an unrecorded change costs a retry rather than a lost operation.
 *
 * `actor_ref` carries the PUBLIC token id, so an investigator can say which
 * directory credential did this and revoke that one.
 */
async function recordScim(db, { tenantId, action, subjectId, detail, actor, ip }) {
  await db.query(
    `INSERT INTO audit_log
       (tenant_id, actor_kind, actor_ref, action, subject_type, subject_id, detail, ip)
     VALUES ($1, 'scim', $2, $3, 'user', $4, $5, $6)`,
    [tenantId, `scim:${actor.tokenId}`, action, subjectId || null,
      JSON.stringify({ token: actor.tokenName, ...(detail || {}) }), ip || null],
  );
}

// ─── Operator CLI ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? next : true;
    if (out[key] !== true) i += 1;
  }
  return out;
}

async function withOwner(fn) {
  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('set DATABASE_MIGRATION_URL to the owner credential');
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/**
 * Record the operator action on the platform trail, reusing the one writer in
 * src/admin/tenants.js so every operator action is recorded the same way and a
 * reader does not have to learn two conventions.
 *
 * Required lazily: the API process has no reason to load the operator tooling
 * into its address space, and this file is on the request path.
 */
function recordAdmin(db, entry) {
  // eslint-disable-next-line global-require
  return require('../admin/tenants').recordAdmin(db, entry);
}

/**
 * Mint a token. The secret is returned ONCE and is not recoverable afterwards,
 * because what is stored is a hash of it.
 */
async function issueToken({ slug, name, expiresDays, noExpiry }) {
  if (!slug || slug === true) throw new Error('--slug is required');
  if (!name || name === true || String(name).length > 100) {
    throw new Error('--name is required (max 100 chars): which directory this is for');
  }

  // One or the other must be STATED. A token that silently never expires
  // because a flag was omitted is how a credential issued for a two-week pilot
  // is still live three years later, in a directory nobody administers.
  const days = expiresDays === undefined ? null : Number(expiresDays);
  if (!noExpiry && (days === null || !Number.isInteger(days) || days < 1)) {
    throw new Error('pass --expires-days <n> (n >= 1) or --no-expiry; a standing '
      + 'credential must not get its lifetime by default');
  }
  if (noExpiry && days !== null) throw new Error('pass one of --expires-days or --no-expiry');

  const tokenId = crypto.randomBytes(ID_BYTES).toString('base64url');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${PREFIX}${tokenId}_${secret}`;
  const expiresAt = noExpiry ? null : new Date(Date.now() + days * 86400_000);

  return withOwner(async (db) => {
    const t = await db.query('SELECT id, status FROM tenants WHERE slug = $1', [slug]);
    if (!t.rows[0]) throw new Error(`no tenant with slug ${slug}`);
    const tenantId = t.rows[0].id;

    const actorRef = process.env.ADMIN_ACTOR || process.env.SUDO_USER
      || process.env.USER || 'unknown';
    await db.query(
      `INSERT INTO scim_tokens (token_id, tenant_id, token_hash, name, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tokenId, tenantId, hashToken(token), String(name), actorRef, expiresAt],
    );
    await recordAdmin(db, {
      tenantId,
      action: 'scim.token_issued',
      subjectType: 'scim_token',
      subjectId: tokenId,
      // The id and the lifetime, never the token. An audit log that contains a
      // live credential is a credential store with a long retention.
      detail: { slug, name: String(name), expiresAt: expiresAt ? expiresAt.toISOString() : null },
    });

    return {
      tenantSlug: slug,
      tokenId,
      token,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      note: 'Copy the token now. Only its hash is stored, so it cannot be shown again.',
    };
  });
}

async function listTokens({ slug } = {}) {
  return withOwner(async (db) => {
    const { rows } = await db.query(
      `SELECT k.token_id, t.slug AS tenant, k.name, k.created_by, k.created_at,
              k.expires_at, k.last_used_at, k.revoked_at
         FROM scim_tokens k JOIN tenants t ON t.id = k.tenant_id
        WHERE ($1::text IS NULL OR t.slug = $1)
        ORDER BY k.created_at`,
      [slug && slug !== true ? slug : null],
    );
    return rows;
  });
}

/**
 * Revoke one token. Takes effect on the next request: authenticate() reads
 * `revoked_at` on every call rather than trusting a cached decision.
 */
async function revokeToken({ tokenId }) {
  if (!tokenId || tokenId === true) throw new Error('--token-id is required');
  return withOwner(async (db) => {
    const { rows } = await db.query(
      `UPDATE scim_tokens SET revoked_at = now()
        WHERE token_id = $1 AND revoked_at IS NULL
        RETURNING token_id, tenant_id, name`,
      [tokenId],
    );
    if (!rows[0]) {
      // Precise, unlike the HTTP path: the audience here is an operator holding
      // the owner credential, and "it did nothing and did not say why" during an
      // incident is worse than useless.
      const existing = await db.query(
        'SELECT revoked_at FROM scim_tokens WHERE token_id = $1', [tokenId],
      );
      throw new Error(existing.rows[0]
        ? `token ${tokenId} was already revoked at ${existing.rows[0].revoked_at.toISOString()}`
        : `no SCIM token with id ${tokenId}`);
    }
    await recordAdmin(db, {
      tenantId: rows[0].tenant_id,
      action: 'scim.token_revoked',
      subjectType: 'scim_token',
      subjectId: tokenId,
      detail: { name: rows[0].name },
    });
    return { tokenId, revoked: true };
  });
}

/** Every token for a tenant — a suspected leak, or the end of a contract. */
async function revokeAllForTenant({ slug }) {
  if (!slug || slug === true) throw new Error('--slug is required');
  return withOwner(async (db) => {
    const { rows } = await db.query(
      `UPDATE scim_tokens SET revoked_at = now()
        WHERE revoked_at IS NULL
          AND tenant_id = (SELECT id FROM tenants WHERE slug = $1)
        RETURNING token_id`,
      [slug],
    );
    await recordAdmin(db, {
      tenantId: null,
      action: 'scim.tokens_revoked',
      subjectType: 'tenant',
      subjectId: slug,
      detail: { slug, revoked: rows.length },
    });
    return { slug, revoked: rows.length, tokenIds: rows.map((r) => r.token_id) };
  });
}

module.exports = {
  authenticate, withScimTenant, recordScim, bearerToken,
  issueToken, listTokens, revokeToken, revokeAllForTenant,
  __internals: { hashToken, safeEqualBytes, parseToken, TOKEN_RE, ABSENT },
};

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const run = {
    issue: () => issueToken({
      slug: args.slug,
      name: args.name,
      expiresDays: args['expires-days'],
      noExpiry: args['no-expiry'] === true,
    }),
    list: () => listTokens({ slug: args.slug }),
    revoke: () => revokeToken({ tokenId: args['token-id'] }),
    'revoke-all': () => revokeAllForTenant({ slug: args.slug }),
  }[command];

  if (!run) {
    console.error('commands: issue | list | revoke | revoke-all');
    process.exit(2);
  }
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
