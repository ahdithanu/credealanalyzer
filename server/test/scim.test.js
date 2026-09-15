'use strict';

/**
 * SCIM, attacked.
 *
 * The happy path is three of these tests. The rest are the ways in, because the
 * credential this endpoint accepts can enumerate and deactivate every user in a
 * firm, and because the one operation that matters — PATCH active=false — is
 * the kind of thing that returns 200 while doing nothing at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');

process.env.SSO_PROVIDER = 'stub';

let env, seed, pool, login, stub, provisioning, scimModule, server, base, owner;
let tokenX, tokenY;

test.before(async () => {
  env = await freshDatabase('scim');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.DATABASE_MIGRATION_URL = env.migrationUrl;
  process.env.APP_ORIGIN = 'http://localhost:3000';

  pool = require('../src/db/pool');
  login = require('../src/auth/login');
  stub = require('../src/auth/broker').broker();
  provisioning = require('../src/auth/provisioning');
  scimModule = require('../src/routes/scim');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  owner = new Client({ connectionString: env.ownerUrl });
  await owner.connect();

  tokenX = (await provisioning.issueToken({ slug: 'firm-x', name: 'Okta prod', expiresDays: 30 })).token;
  tokenY = (await provisioning.issueToken({ slug: 'firm-y', name: 'Entra prod', expiresDays: 30 })).token;
});

test.after(async () => {
  if (owner) await owner.end();
  if (server) await new Promise((r) => server.close(r));
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

// Every test starts with a clean limiter. Otherwise the file's own traffic —
// which is what an attack suite looks like — would start refusing itself part
// way through and the failure would read as a bug in whatever test ran 121st.
test.beforeEach(() => scimModule.__internals.__resetRateLimit());

/** A SCIM client bound to one token, or to none. */
function scim(token) {
  return (path, init = {}) => fetch(`${base}/scim/v2${path}`, {
    ...init,
    headers: {
      'content-type': 'application/scim+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
}

/** A signed-in browser session for a user, so there is something to revoke. */
async function signIn(org, email) {
  const begun = await login.begin({ redirectTo: '/' });
  const code = new URL(begun.url).searchParams.get('code');
  stub.__setProfile(code, {
    organizationId: org, email, emailVerified: true, externalId: `idp|${email}`,
    name: 'Test User', connectionId: 'conn', idpName: 'stub',
  });
  const done = await login.complete({ state: begun.state, code, ip: '198.51.100.9' });
  const cookie = `cre_session=${encodeURIComponent(done.token)}`;
  return {
    cookie,
    token: done.token,
    /** The check that matters: can this session still reach deal data? */
    stillWorks: async () => (await fetch(`${base}/api/deals`, { headers: { cookie } })).status === 200,
  };
}

const ownerQuery = (sql, params) => owner.query(sql, params).then((r) => r.rows);

async function userRow(email) {
  const rows = await ownerQuery('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0];
}

// ─── Authentication ─────────────────────────────────────────────────────────

test('a request with no token is refused in the SCIM error schema', async () => {
  const r = await scim(null)('/Users');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('content-type'), /application\/scim\+json/);
  assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="scim"');
  const body = await r.json();
  assert.deepEqual(body.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
  // A STRING. Several directories reject the numeric form and report it to the
  // administrator as an unreadable response rather than as a rejected token.
  assert.strictEqual(body.status, '401');
  assert.ok(typeof body.detail === 'string' && body.detail.length > 0);
});

test('every rejected token gives byte-identical answers, so nothing can be probed', async () => {
  // The attack: learn which token ids exist, or whether a tenant exists at all,
  // by comparing responses. A real token id is half of a credential.
  const valid = tokenX;
  const [id, secret] = valid.slice('scim_'.length).split('_');
  const candidates = [
    'garbage',
    'scim_notavalidid_x',
    `scim_${id}_${'A'.repeat(43)}`,           // real id, wrong secret
    `scim_${'a'.repeat(12)}_${secret}`,       // real secret, wrong id
    valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A'), // one character off
  ];
  const seen = [];
  for (const candidate of candidates) {
    scimModule.__internals.__resetRateLimit();
    const r = await scim(candidate)('/Users');
    assert.equal(r.status, 401, `${candidate} was not refused`);
    seen.push(JSON.stringify(await r.json()));
  }
  assert.equal(new Set(seen).size, 1, 'the rejection bodies differ between causes');
});

test('the database holds no usable token', async () => {
  // A leaked dump — a backup, an over-broad support query, a snapshot restored
  // onto a laptop — must not contain a credential anyone can present.
  const rows = await ownerQuery('SELECT * FROM scim_tokens');
  assert.ok(rows.length >= 2);
  const dump = JSON.stringify(rows);
  const [, id, secret] = /^scim_([^_]+)_(.+)$/.exec(tokenX);
  assert.ok(!dump.includes(secret), 'the secret half of the token is recoverable from the table');
  assert.ok(!dump.includes(tokenX), 'the token itself is stored');
  // The public half IS stored: it is what the lookup selects on.
  assert.ok(dump.includes(id));
});

test('a token that has been revoked stops working on the very next call', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'temp', expiresDays: 1 });
  assert.equal((await scim(issued.token)('/Users')).status, 200);

  await provisioning.revokeToken({ tokenId: issued.tokenId });

  assert.equal((await scim(issued.token)('/Users')).status, 401,
    'a revoked token was still accepted — revocation that takes effect later is not revocation');
});

test('an expired token is refused, and a token with no expiry must be asked for', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'short', expiresDays: 1 });
  await ownerQuery("UPDATE scim_tokens SET expires_at = now() - interval '1 second' WHERE token_id = $1",
    [issued.tokenId]);
  assert.equal((await scim(issued.token)('/Users')).status, 401);

  // A standing credential must not acquire an unlimited life because a flag was
  // left off the command line.
  await assert.rejects(
    () => provisioning.issueToken({ slug: 'firm-x', name: 'careless' }),
    /--expires-days|--no-expiry/,
  );
  const forever = await provisioning.issueToken({ slug: 'firm-x', name: 'stated', noExpiry: true });
  assert.equal(forever.expiresAt, null, 'no expiry must be recorded as null, not as a far-off date');
  assert.equal((await scim(forever.token)('/Users')).status, 200);
});

test('a suspended tenant loses its directory sync without anyone revoking a token', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-y', name: 'y-sync', expiresDays: 1 });
  assert.equal((await scim(issued.token)('/Users')).status, 200);
  await ownerQuery("UPDATE tenants SET status = 'suspended' WHERE slug = 'firm-y'");
  assert.equal((await scim(issued.token)('/Users')).status, 401);
  await ownerQuery("UPDATE tenants SET status = 'active' WHERE slug = 'firm-y'");
});

// ─── The tenant comes from the token ────────────────────────────────────────

test('a token for one firm cannot see, or touch, another firm\'s users', async () => {
  const list = await (await scim(tokenX)('/Users')).json();
  const names = list.Resources.map((u) => u.userName);
  assert.ok(names.includes('analyst@firmx.com'));
  assert.ok(!names.includes('analyst@firmy.com'), 'a SCIM token enumerated another firm\'s users');

  // By id, which is the form that bypasses any list filter.
  const foreign = await ownerQuery('SELECT id FROM users WHERE email = $1', ['analyst@firmy.com']);
  const read = await scim(tokenX)(`/Users/${foreign[0].id}`);
  // 404 rather than 403: a 403 would confirm that the id exists.
  assert.equal(read.status, 404);

  const patched = await scim(tokenX)(`/Users/${foreign[0].id}`, {
    method: 'PATCH',
    body: JSON.stringify({ Operations: [{ op: 'replace', path: 'active', value: false }] }),
  });
  assert.equal(patched.status, 404);
  const still = await userRow('analyst@firmy.com');
  assert.equal(still.active, true, 'a token for firm X deactivated a user in firm Y');

  // And the mirror image, so this is not passing because firm Y is empty.
  const theirs = await (await scim(tokenY)('/Users')).json();
  assert.deepEqual(theirs.Resources.map((u) => u.userName), ['analyst@firmy.com']);
});

test('a header, a path or a body cannot choose the tenant; only the token does', async () => {
  // The attack this file exists for, in the shape it always takes: the caller
  // asserting a tenant. Every one of these is attacker-controlled.
  const r = await scim(tokenX)('/Users', {
    headers: {
      'x-tenant-id': seed.b.tenantId,
      'x-tenant': 'firm-y',
      'x-scim-tenant': 'firm-y',
    },
  });
  assert.equal(r.status, 200);
  const names = (await r.json()).Resources.map((u) => u.userName);
  assert.ok(names.every((n) => n.endsWith('@firmx.com')), 'a header changed the tenant');

  const created = await scim(tokenX)('/Users', {
    method: 'POST',
    body: JSON.stringify({
      userName: 'planted@firmx.com',
      tenantId: seed.b.tenantId,
      tenant_id: seed.b.tenantId,
    }),
  });
  assert.equal(created.status, 201);
  const row = await userRow('planted@firmx.com');
  assert.equal(row.tenant_id, seed.a.tenantId, 'the body placed a user in another firm');
});

// ─── Provisioning ───────────────────────────────────────────────────────────

test('creating a user gives back a SCIM resource and a Location', async () => {
  const r = await scim(tokenX)('/Users', {
    method: 'POST',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'NewJoiner@FirmX.com',
      name: { givenName: 'New', familyName: 'Joiner' },
      externalId: 'okta-123',
    }),
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.schemas[0], 'urn:ietf:params:scim:schemas:core:2.0:User');
  // Normalised, because the login path lowercases an asserted address and two
  // rows for one person means deprovisioning one and leaving the other.
  assert.equal(body.userName, 'newjoiner@firmx.com');
  assert.equal(body.active, true);
  assert.equal(body.externalId, 'okta-123');
  assert.ok(r.headers.get('location').endsWith(`/scim/v2/Users/${body.id}`));
  assert.equal(body.meta.resourceType, 'User');
  assert.ok(body.meta.lastModified, 'a row written now has a known last-modified time');
});

test('a name we were not given is null, not a guess', async () => {
  const r = await scim(tokenX)('/Users', {
    method: 'POST',
    body: JSON.stringify({ userName: 'nameless@firmx.com' }),
  });
  const body = await r.json();
  assert.equal(body.name.formatted, null);
  assert.equal(body.displayName, null);
  // And for a user whose display name we DO hold, the halves we do not hold
  // stay null rather than being split out of it.
  const one = await (await scim(tokenX)(
    `/Users?filter=${encodeURIComponent('userName eq "analyst@firmx.com"')}`)).json();
  assert.equal(one.Resources[0].name.formatted, 'An Analyst');
  assert.equal(one.Resources[0].name.givenName, null);
  assert.equal(one.Resources[0].name.familyName, null);
});

test('creating the same userName twice is a 409 the directory can act on', async () => {
  const body = JSON.stringify({ userName: 'twice@firmx.com' });
  assert.equal((await scim(tokenX)('/Users', { method: 'POST', body })).status, 201);
  const second = await scim(tokenX)('/Users', { method: 'POST', body });
  assert.equal(second.status, 409);
  const err = await second.json();
  assert.equal(err.scimType, 'uniqueness');
  assert.deepEqual(err.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
});

test('a userName that is not an address is refused before it reaches the table', async () => {
  for (const userName of [undefined, null, '', 'not-an-email', 'a@b', 42, { }]) {
    const r = await scim(tokenX)('/Users', { method: 'POST', body: JSON.stringify({ userName }) });
    assert.equal(r.status, 400, `${JSON.stringify(userName)} was accepted`);
    assert.equal((await r.json()).scimType, 'invalidValue');
  }
});

test('only the filter a directory actually needs is honoured; the rest are refused', async () => {
  const found = await (await scim(tokenX)(
    `/Users?filter=${encodeURIComponent('userName eq "analyst@firmx.com"')}`)).json();
  assert.equal(found.totalResults, 1);
  assert.equal(found.Resources[0].userName, 'analyst@firmx.com');
  assert.deepEqual(found.schemas, ['urn:ietf:params:scim:api:messages:2.0:ListResponse']);

  // A filter we silently ignored would answer "does this person exist" with the
  // entire user list, and the directory would act on the first row.
  for (const filter of ['userName sw "an"', 'active eq true', 'userName eq "a" or id pr', 'nonsense']) {
    const r = await scim(tokenX)(`/Users?filter=${encodeURIComponent(filter)}`);
    assert.equal(r.status, 400, `${filter} was not refused`);
    assert.equal((await r.json()).scimType, 'invalidFilter');
  }
});

// ─── Deprovisioning: the reason this exists ─────────────────────────────────

test('PATCH active=false deactivates AND kills every live session, in one transaction', async () => {
  const email = 'departing@firmx.com';
  await scim(tokenX)('/Users', { method: 'POST', body: JSON.stringify({ userName: email }) });

  const one = await signIn('org_x', email);
  const two = await signIn('org_x', email);
  assert.ok(await one.stillWorks(), 'the fixture is broken: the session never worked');
  assert.ok(await two.stillWorks());

  const user = await userRow(email);
  const r = await scim(tokenX)(`/Users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: false } }],
    }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).active, false);

  // THE ASSERTION THE FEATURE IS FOR. Disabling someone in the directory that
  // leaves their live session working is the exposure window this closes.
  assert.equal(await one.stillWorks(), false, 'a live session survived deprovisioning');
  assert.equal(await two.stillWorks(), false, 'a second live session survived deprovisioning');

  const live = await ownerQuery(
    'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [user.id],
  );
  assert.equal(live[0].n, 0);
  const after = await userRow(email);
  assert.equal(after.active, false);
  assert.ok(after.deactivated_at, 'the deactivation was not dated');
});

test('Entra sends the STRING "False", and it must deprovision', async () => {
  // Boolean("False") is true. Under a naive coercion the account stays active,
  // the sync reports success, and the analyst keeps their access — the failure
  // this feature exists to prevent, arriving as a green tick.
  const email = 'entra@firmx.com';
  await scim(tokenX)('/Users', { method: 'POST', body: JSON.stringify({ userName: email }) });
  const user = await userRow(email);
  const session = await signIn('org_x', email);
  assert.ok(await session.stillWorks());

  const r = await scim(tokenX)(`/Users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      // Capitalised op and a quoted boolean: this is ordinary Entra traffic.
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).active, false);
  assert.equal((await userRow(email)).active, false, 'the string "False" left the account active');
  assert.equal(await session.stillWorks(), false);
});

test('a value that is not a boolean is refused rather than guessed', async () => {
  const user = await userRow('analyst@firmx.com');
  for (const value of ['yes', 1, 0, null, 'disabled', {}]) {
    const r = await scim(tokenX)(`/Users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ Operations: [{ op: 'replace', path: 'active', value }] }),
    });
    assert.equal(r.status, 400, `${JSON.stringify(value)} was interpreted as a boolean`);
    assert.equal((await r.json()).scimType, 'invalidValue');
  }
  assert.equal((await userRow('analyst@firmx.com')).active, true);
});

test('an urn-qualified path and a bare one both work, and unknown attributes ride along', async () => {
  const email = 'urnpath@firmx.com';
  await scim(tokenX)('/Users', { method: 'POST', body: JSON.stringify({ userName: email }) });
  const user = await userRow(email);
  const r = await scim(tokenX)(`/Users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      Operations: [
        // Attributes we do not store arrive in the same request as the one that
        // matters. Refusing the request because of them refuses the
        // deprovisioning.
        { op: 'replace', path: 'title', value: 'Associate' },
        { op: 'replace', path: 'urn:ietf:params:scim:schemas:core:2.0:User:active', value: false },
      ],
    }),
  });
  assert.equal(r.status, 200);
  assert.equal((await userRow(email)).active, false);
});

test('DELETE deactivates and revokes, and keeps the person for attribution', async () => {
  const email = 'deleted@firmx.com';
  await scim(tokenX)('/Users', { method: 'POST', body: JSON.stringify({ userName: email }) });
  const user = await userRow(email);
  const session = await signIn('org_x', email);
  assert.ok(await session.stillWorks());

  const r = await scim(tokenX)(`/Users/${user.id}`, { method: 'DELETE' });
  assert.equal(r.status, 204);
  assert.equal(await session.stillWorks(), false);

  // The row survives: erasing it would null the author of every deal they
  // underwrote and orphan every audit entry naming them.
  const after = await userRow(email);
  assert.ok(after, 'the user row was erased by a directory sync');
  assert.equal(after.active, false);
});

test('a deactivated user cannot be handed a new session even by a successful handshake', async () => {
  // The backstop. Deprovisioning is driven BY the directory disabling someone,
  // so a login should never get this far — and if it does, the database refuses
  // rather than the account quietly coming back.
  const email = 'departing@firmx.com';
  assert.equal((await userRow(email)).active, false, 'fixture: this user should be deactivated');
  await assert.rejects(() => signIn('org_x', email),
    // Refused by the policy in migration 007, not by something incidental.
    /row-level security|auth_session_active_user/i);
  const live = await ownerQuery(
    `SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.email = $1 AND s.revoked_at IS NULL`, [email],
  );
  assert.equal(live[0].n, 0);
});

test('a PUT that forgets to mention active does not resurrect a deactivated account', async () => {
  const email = 'deleted@firmx.com';
  const user = await userRow(email);
  assert.equal(user.active, false);

  const r = await scim(tokenX)(`/Users/${user.id}`, {
    method: 'PUT',
    body: JSON.stringify({ userName: email, name: { formatted: 'Renamed Person' } }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).active, false,
    'a payload that omitted a field readmitted an offboarded analyst');
  const after = await userRow(email);
  assert.equal(after.active, false);
  assert.equal(after.name, 'Renamed Person', 'the attributes that were sent were not applied');
});

test('reactivation is possible, is explicit, and does not bring the old sessions back', async () => {
  const email = 'deleted@firmx.com';
  const user = await userRow(email);
  const r = await scim(tokenX)(`/Users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ Operations: [{ op: 'replace', path: 'active', value: true }] }),
  });
  assert.equal(r.status, 200);
  const after = await userRow(email);
  assert.equal(after.active, true);
  assert.equal(after.deactivated_at, null, 'a deactivation date survived on an active account');
  const live = await ownerQuery(
    'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [user.id],
  );
  assert.equal(live[0].n, 0, 'revoked sessions came back to life on reactivation');
});

// ─── Audit ──────────────────────────────────────────────────────────────────

test('every SCIM operation is attributed to the machine that made it', async () => {
  const rows = await ownerQuery(
    `SELECT action, actor_kind, actor_ref, subject_id, detail, tenant_id
       FROM audit_log WHERE actor_kind = 'scim' ORDER BY id`);
  assert.ok(rows.length > 0, 'no SCIM operation was audited');

  // Not `user` (there is no person), not `system` (this is an outside party's
  // decision, and recording it under our own name misleads an investigator).
  assert.ok(rows.every((r) => r.actor_kind === 'scim'));
  assert.ok(rows.every((r) => /^scim:/.test(r.actor_ref)),
    'the trail does not say which directory credential acted');
  for (const action of ['scim.user.listed', 'scim.user.read', 'scim.user.created',
    'scim.user.deactivated', 'scim.user.reactivated', 'scim.user.updated']) {
    assert.ok(rows.some((r) => r.action === action), `${action} was never audited`);
  }

  const deactivations = rows.filter((r) => r.action === 'scim.user.deactivated');
  // The question an incident review asks is not "was the account disabled" but
  // "how many live sessions did that actually end".
  assert.ok(deactivations.some((r) => r.detail.sessionsRevoked >= 2),
    'the number of sessions revoked was not recorded');
  assert.ok(deactivations.every((r) => typeof r.detail.sessionsRevoked === 'number'));

  // Never a platform-level row: an entry with no tenant is invisible to every
  // firm under the policy in 001, so a SCIM action recorded that way would be
  // an action the customer cannot see in their own trail.
  assert.ok(rows.every((r) => r.tenant_id === seed.a.tenantId || r.tenant_id === seed.b.tenantId));
});

test('the audit trail a SCIM token writes stays inside its own tenant', async () => {
  const before = await ownerQuery(
    `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND actor_kind = 'scim'`,
    [seed.b.tenantId]);
  await scim(tokenX)('/Users');
  const after = await ownerQuery(
    `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND actor_kind = 'scim'`,
    [seed.b.tenantId]);
  assert.equal(after[0].n, before[0].n, 'a firm X sync wrote into firm Y\'s trail');
});

test('the hash chain still verifies after machine-written entries', async () => {
  // actor_kind is part of the digest in migration 003. A new kind that was not
  // covered would break tamper evidence for every entry after it.
  const broken = await ownerQuery('SELECT * FROM audit_log_verify(0)');
  assert.deepEqual(broken, []);
});

// ─── Shape and limits ───────────────────────────────────────────────────────

test('a malformed body and an unknown endpoint both answer in SCIM\'s schema', async () => {
  const bad = await scim(tokenX)('/Users', { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).scimType, 'invalidSyntax');

  const missing = await scim(tokenX)('/Groups');
  assert.equal(missing.status, 404);
  assert.deepEqual((await missing.json()).schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
});

test('the service describes itself, but only to a caller holding a token', async () => {
  assert.equal((await scim(null)('/ServiceProviderConfig')).status, 401);
  const r = await scim(tokenX)('/ServiceProviderConfig');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.patch.supported, true);
  assert.equal(body.authenticationSchemes[0].type, 'oauthbearertoken');
});

test('SCIM has its own ceiling, and says so in SCIM', async () => {
  const issued = await provisioning.issueToken({ slug: 'firm-x', name: 'noisy', expiresDays: 1 });
  const call = scim(issued.token);
  let refused = null;
  for (let i = 0; i < 130 && !refused; i += 1) {
    const r = await call(`/Users?filter=${encodeURIComponent('userName eq "analyst@firmx.com"')}`);
    if (r.status === 429) refused = r;
  }
  assert.ok(refused, 'a single token was never rate limited');
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  const body = await refused.json();
  assert.equal(body.status, '429');
  assert.deepEqual(body.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);

  // And the ceiling is the TOKEN's, not the address's: directories share egress
  // addresses, so one firm's noise must not stop another firm's deprovisioning.
  assert.equal((await scim(tokenX)('/Users')).status, 200);
});

test('unauthenticated probing is cut off far sooner than legitimate traffic', async () => {
  let refused = false;
  for (let i = 0; i < 40 && !refused; i += 1) {
    refused = (await scim(null)('/Users')).status === 429;
  }
  assert.ok(refused, 'anonymous calls were never limited');
});

test('rotating made-up tokens does not buy a fresh bucket each time', async () => {
  // Keying only on the token would let an attacker reset their own limit on
  // every request, which is the brute force a limiter exists to stop.
  let refused = false;
  for (let i = 0; i < 60 && !refused; i += 1) {
    const r = await scim(`scim_${'a'.repeat(12)}_${String(i).padStart(43, 'b')}`)('/Users');
    refused = r.status === 429;
  }
  assert.ok(refused, 'made-up tokens were tried without limit');
});
