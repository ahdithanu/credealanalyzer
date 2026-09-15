'use strict';

/**
 * SCIM credentials, below the HTTP layer.
 *
 * scim.test.js proves the endpoint behaves; this file proves the two properties
 * the endpoint rests on and which no request can demonstrate on its own: that
 * the stored credential cannot be turned back into a usable one, and that the
 * tenant boundary around a SCIM transaction is the database's rather than the
 * route's.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');

let env, seed, pool, provisioning, owner;

test.before(async () => {
  env = await freshDatabase('scimtokens');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.DATABASE_MIGRATION_URL = env.ownerUrl;
  pool = require('../src/db/pool');
  provisioning = require('../src/auth/provisioning');
  owner = new Client({ connectionString: env.ownerUrl });
  await owner.connect();
});

test.after(async () => {
  if (owner) await owner.end();
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

const ownerQuery = (sql, params) => owner.query(sql, params).then((r) => r.rows);
const header = (token) => `Bearer ${token}`;
/** The secret half. Split on the FIRST separator after the fixed-width id: a
 *  base64url secret contains underscores of its own. */
const secretOf = (token) => /^scim_.{12}_(.+)$/.exec(token)[1];

// ─── Storage ────────────────────────────────────────────────────────────────

test('only a hash is stored, and it is a hash of the whole token', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'okta', expiresDays: 7 });
  const rows = await ownerQuery('SELECT * FROM scim_tokens WHERE token_id = $1', [issued.tokenId]);
  const row = rows[0];

  assert.ok(Buffer.isBuffer(row.token_hash));
  assert.deepEqual(
    row.token_hash,
    crypto.createHash('sha256').update(issued.token, 'utf8').digest(),
    'the stored digest does not cover the whole token, so a secret could be replayed against another id',
  );
  // Nothing in the row, in any column, can be presented.
  const asText = Object.values(row).map((v) => (Buffer.isBuffer(v) ? v.toString('hex') : String(v))).join('|');
  assert.ok(!asText.includes(secretOf(issued.token)));
  assert.equal(row.last_used_at, null, 'an unused token must say so with null, not with a date');
});

test('the token is shown once and cannot be recovered afterwards', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'once', expiresDays: 7 });
  const listed = await provisioning.listTokens({ slug: 'firm-x' });
  const entry = listed.find((t) => t.token_id === issued.tokenId);
  assert.ok(entry, 'the operator cannot see which tokens exist');
  assert.ok(!JSON.stringify(listed).includes(secretOf(issued.token)));
});

test('issuing and revoking a machine credential leaves an operator trail', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'audited', expiresDays: 7 });
  await provisioning.revokeToken({ tokenId: issued.tokenId });
  const rows = await ownerQuery(
    `SELECT action, actor_kind, subject_type, subject_id, detail FROM audit_log
      WHERE subject_id = $1 ORDER BY id`, [issued.tokenId]);
  assert.deepEqual(rows.map((r) => r.action), ['scim.token_issued', 'scim.token_revoked']);
  // The holder of the owner credential, not an end user and not a machine.
  assert.ok(rows.every((r) => r.actor_kind === 'operator' && r.subject_type === 'scim_token'));
  // The trail records the lifetime and the name. It must never record the token.
  assert.ok(!JSON.stringify(rows).includes(secretOf(issued.token)));
});

// ─── Verification ───────────────────────────────────────────────────────────

test('a valid token resolves to its own tenant and nothing else decides that', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-y', name: 'y', expiresDays: 7 });
  const actor = await provisioning.authenticate(header(issued.token));
  assert.equal(actor.tenantId, seed.b.tenantId);
  assert.equal(actor.tenantSlug, 'firm-y');
  assert.equal(actor.tokenId, issued.tokenId);
  assert.equal(actor.tokenName, 'y');
});

test('a near-miss token is refused', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'near', expiresDays: 7 });
  const tokenId = issued.tokenId;
  const secret = secretOf(issued.token);

  const attempts = [
    undefined, null, '', 'Bearer', 'Bearer ', header(''),
    header(issued.token.slice(0, -1)),                       // truncated
    header(`${issued.token}x`),                              // extended
    header(issued.token.toUpperCase()),                      // case-shifted
    header(`scim_${tokenId}_${'z'.repeat(43)}`),             // right id, wrong secret
    header(`scim_${tokenId}`),                               // id half only
    // The secret under someone else's id must fail, which is what binding the
    // digest to the whole token buys.
    header(`scim_${'q'.repeat(12)}_${secret}`),
    `Basic ${Buffer.from(`x:${issued.token}`).toString('base64')}`,
    issued.token,                                            // no scheme at all
  ];
  for (const attempt of attempts) {
    assert.equal(await provisioning.authenticate(attempt), null,
      `${JSON.stringify(attempt)} was accepted`);
  }
  // And the real thing still works, so the test above is not passing vacuously.
  assert.ok(await provisioning.authenticate(header(issued.token)));
});

test('the comparison is constant time and length-safe', async () => {
  const { safeEqualBytes, hashToken, ABSENT } = provisioning.__internals;
  assert.equal(safeEqualBytes(hashToken('a'), hashToken('a')), true);
  assert.equal(safeEqualBytes(hashToken('a'), hashToken('b')), false);
  // timingSafeEqual throws on a length mismatch; a wrapper that let that
  // propagate would turn a short token into a 500 and a distinguishable one.
  assert.equal(safeEqualBytes(Buffer.alloc(3), ABSENT), false);
  assert.equal(safeEqualBytes(null, ABSENT), false);
  assert.equal(safeEqualBytes(undefined, undefined), false);
});

test('using a token records that it was used, so an operator can retire it safely', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'used', expiresDays: 7 });
  await provisioning.authenticate(header(issued.token));
  // The stamp is deliberately not awaited by the authentication path, so give
  // it a moment before asking.
  await new Promise((r) => setTimeout(r, 120));
  const rows = await ownerQuery('SELECT last_used_at FROM scim_tokens WHERE token_id = $1',
    [issued.tokenId]);
  assert.ok(rows[0].last_used_at, 'a token in daily use still looks unused');
});

test('the authentication role cannot lift its own restrictions on a token', async () => {
  // It may stamp last_used_at and nothing else: a flaw on the request path must
  // not be able to un-revoke a credential or extend its life.
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'locked', expiresDays: 1 });
  await provisioning.revokeToken({ tokenId: issued.tokenId });
  const auth = new Client({ connectionString: env.authUrl });
  await auth.connect();
  try {
    await assert.rejects(
      () => auth.query('UPDATE scim_tokens SET revoked_at = NULL WHERE token_id = $1', [issued.tokenId]),
      /permission denied/i,
    );
    await assert.rejects(
      () => auth.query("UPDATE scim_tokens SET expires_at = now() + interval '10 years'"),
      /permission denied/i,
    );
    await assert.rejects(
      () => auth.query('INSERT INTO scim_tokens (token_id, tenant_id, token_hash, name) '
        + "VALUES ('self', $1, '\\x00', 'minted by the api')", [seed.a.tenantId]),
      /permission denied/i,
    );
  } finally { await auth.end(); }
  assert.equal(await provisioning.authenticate(header(issued.token)), null);
});

test('the tenant-data role cannot read a SCIM token at all', async () => {
  // The same split as `sessions` in migration 002: a flaw in the route that
  // serves deals must not be able to mint or read a provisioning credential.
  const app = new Client({ connectionString: env.appUrl });
  await app.connect();
  try {
    await assert.rejects(() => app.query('SELECT token_hash FROM scim_tokens'), /permission denied/i);
  } finally { await app.end(); }
});

// ─── The boundary around a SCIM transaction ─────────────────────────────────

test('inside a SCIM transaction the database, not the query, scopes the tenant', async () => {
  // The house rule is that isolation is a property of the database. These are
  // the queries a route would write with its predicate forgotten.
  const rows = await provisioning.withScimTenant(seed.a.tenantId, async (db) => {
    const users = await db.query('SELECT email FROM users');
    const sessions = await db.query('SELECT id FROM sessions');
    return { users: users.rows.map((r) => r.email), sessions: sessions.rows.length };
  });
  assert.deepEqual(rows.users, ['analyst@firmx.com']);
  assert.equal(rows.sessions, 0);
});

test('a SCIM transaction cannot revoke, read or write another firm\'s rows', async () => {
  // Hand the firm X context firm Y's own user id — the id an attacker would
  // have if they had ever seen one — and watch every statement do nothing.
  const foreignUser = seed.b.userId;
  await ownerQuery(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [crypto.randomBytes(32), foreignUser, seed.b.tenantId],
  );

  const result = await provisioning.withScimTenant(seed.a.tenantId, async (db) => {
    const revoked = await db.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [foreignUser],
    );
    const deactivated = await db.query(
      'UPDATE users SET active = false WHERE id = $1', [foreignUser],
    );
    const read = await db.query('SELECT id FROM users WHERE id = $1', [foreignUser]);
    return { revoked: revoked.rowCount, deactivated: deactivated.rowCount, read: read.rows.length };
  });
  assert.deepEqual(result, { revoked: 0, deactivated: 0, read: 0 });

  const live = await ownerQuery(
    'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [foreignUser]);
  assert.equal(live[0].n, 1, 'a firm X context revoked a firm Y session');
  const stillActive = await ownerQuery('SELECT active FROM users WHERE id = $1', [foreignUser]);
  assert.equal(stillActive[0].active, true);
});

test('a SCIM transaction cannot move a user between firms, or promote one', async () => {
  await assert.rejects(
    () => provisioning.withScimTenant(seed.a.tenantId, (db) => db.query(
      'INSERT INTO users (tenant_id, email) VALUES ($1, $2)',
      [seed.b.tenantId, 'planted@firmy.com'],
    )),
    /row-level security|permission denied/i,
    'a SCIM transaction wrote a user into another firm',
  );
  await assert.rejects(
    () => provisioning.withScimTenant(seed.a.tenantId, (db) => db.query(
      "UPDATE users SET role = 'admin' WHERE email = 'analyst@firmx.com'",
    )),
    /permission denied/i,
    'a directory sync could promote a user to admin',
  );
});

test('a tenant id that is not a uuid never reaches the database', async () => {
  for (const bad of ['', null, undefined, 'all', "' OR 1=1 --", seed.a.tenantId.slice(0, -1)]) {
    await assert.rejects(
      () => provisioning.withScimTenant(bad, async () => 'reached the callback'),
      /must be a uuid/,
      `${JSON.stringify(bad)} was accepted as a tenant`,
    );
  }
});

// ─── The operator CLI ───────────────────────────────────────────────────────

test('issuing against an unknown tenant fails rather than creating one', async () => {
  await assert.rejects(
    () => provisioning.issueToken({ slug: 'firm-z', name: 'ghost', expiresDays: 1 }),
    /no tenant with slug/,
  );
});

test('a token must be issued to a named directory with a stated lifetime', async () => {
  await assert.rejects(() => provisioning.issueToken({ name: 'x', expiresDays: 1 }), /--slug/);
  await assert.rejects(() => provisioning.issueToken({ slug: 'firm-x', expiresDays: 1 }), /--name/);
  for (const expiresDays of [0, -1, 1.5, 'soon']) {
    await assert.rejects(
      () => provisioning.issueToken({ slug: 'firm-x', name: 'bad', expiresDays }),
      /--expires-days/,
      `${expiresDays} was accepted as a lifetime`,
    );
  }
  await assert.rejects(
    () => provisioning.issueToken({ slug: 'firm-x', name: 'both', expiresDays: 5, noExpiry: true }),
    /one of/,
  );
});

test('revoking says plainly what it did, because it is run during an incident', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'incident', expiresDays: 1 });
  assert.deepEqual(await provisioning.revokeToken({ tokenId: issued.tokenId }),
    { tokenId: issued.tokenId, revoked: true });
  await assert.rejects(() => provisioning.revokeToken({ tokenId: issued.tokenId }),
    /already revoked at/);
  await assert.rejects(() => provisioning.revokeToken({ tokenId: 'nope' }), /no SCIM token/);
  await assert.rejects(() => provisioning.revokeToken({}), /--token-id/);
});

test('every token for a firm can be revoked at once, and only that firm\'s', async () => {
  const x = await provisioning.issueToken({ slug: 'firm-x', name: 'bulk-x', expiresDays: 1 });
  const y = await provisioning.issueToken({ slug: 'firm-y', name: 'bulk-y', expiresDays: 1 });
  const result = await provisioning.revokeAllForTenant({ slug: 'firm-x' });
  assert.ok(result.tokenIds.includes(x.tokenId));
  assert.ok(!result.tokenIds.includes(y.tokenId));
  assert.equal(await provisioning.authenticate(header(x.token)), null);
  assert.ok(await provisioning.authenticate(header(y.token)), 'firm Y lost its sync too');
});

test('the secret comparison is constant time, and a regression is caught', () => {
  // The existing test named "constant time" exercised only the guards ABOVE the
  // compare — non-buffer, empty, length mismatch — so replacing
  // crypto.timingSafeEqual with Buffer.equals() left the whole suite green. A
  // timing oracle on a standing credential that can deactivate every user in a
  // tenant would have shipped silently.
  //
  // Asserting timing directly is flaky under a JIT and a loaded CI box, so this
  // asserts the PROPERTY that makes it constant time: the implementation calls
  // crypto.timingSafeEqual. Crude, and it is the thing that actually fails when
  // someone reaches for the convenient alternative.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'auth', 'provisioning.js'), 'utf8');
  const fn = src.slice(src.indexOf('function safeEqualBytes'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  assert.match(body, /crypto\.timingSafeEqual\(/,
    'the secret compare must use crypto.timingSafeEqual');
  assert.ok(!/\.equals\(|===\s*b\b|a\s*===/.test(body),
    `a short-circuiting comparison crept into safeEqualBytes: ${body}`);

  // And the guards still behave, since timingSafeEqual throws on a length
  // mismatch rather than returning false.
  const { __internals } = require('../src/auth/provisioning');
  if (__internals && __internals.safeEqualBytes) {
    const eq = __internals.safeEqualBytes;
    assert.equal(eq(Buffer.from('abc'), Buffer.from('abcd')), false);
    assert.equal(eq(Buffer.alloc(0), Buffer.alloc(0)), false);
    assert.equal(eq('abc', Buffer.from('abc')), false);
    assert.equal(eq(Buffer.from('abc'), Buffer.from('abc')), true);
  }
});
