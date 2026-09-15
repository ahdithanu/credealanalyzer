'use strict';

/**
 * GET /api/export — the portability archive.
 *
 * Three claims are tested rather than assumed: that the archive is COMPLETE
 * (including the rows the firm deleted, which an export that quietly drops them
 * makes a lie of), that it is TENANT-SCOPED, and that the disclosure is recorded
 * BEFORE anything is sent — because an export that dies halfway has still
 * disclosed whatever reached the wire, and an entry written on success is
 * missing from precisely the incidents worth investigating.
 *
 * The ordering has a proof that does not depend on timing: the archive contains
 * the audit entry for its own creation. It can only do that if the entry was
 * committed before the streaming transaction took its snapshot.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');

process.env.SSO_PROVIDER = 'stub';
process.env.KEY_PROVIDER = 'local';
process.env.LOCAL_MASTER_KEY = 'test-master-key-for-the-export-suite-0123456789';

let env, seed, server, base, login, stub, pool, rateLimitMod;

test.before(async () => {
  env = await freshDatabase('export');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.APP_ORIGIN = 'http://localhost:3000';

  login = require('../src/auth/login');
  pool = require('../src/db/pool');
  rateLimitMod = require('../src/middleware/rateLimit');
  stub = require('../src/auth/broker').broker();

  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Firm X gets an admin, a firm default, a live deal and a deleted one.
  await setRole(seed.a.tenantId, 'analyst@firmx.com', 'admin');
  await setRole(seed.b.tenantId, 'analyst@firmy.com', 'admin');
  await pool.withTenant(seed.a.tenantId, seed.a.userId, (db) => db.query(
    `INSERT INTO firm_defaults (tenant_id, version, assumptions)
     VALUES ($1, '2026.1', '{"minDscr":1.25}')`, [seed.a.tenantId]));
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

// The export limiter is deliberately tight (5/minute), so the suite would trip
// over its own thoroughness without this.
test.beforeEach(() => rateLimitMod.__reset());

const ownerQuery = async (sql, params = []) => {
  const c = new Client({ connectionString: env.ownerUrl });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
};

async function setRole(tenantId, email, role) {
  await pool.withTenant(tenantId, null, (db) =>
    db.query('UPDATE users SET role = $1 WHERE email = $2', [role, email]));
}

async function signIn(org, email) {
  const begun = await login.begin({ redirectTo: '/' });
  const code = new URL(begun.url).searchParams.get('code');
  stub.__setProfile(code, {
    organizationId: org, email, emailVerified: true, externalId: `idp|${email}`,
    name: 'Test User', connectionId: 'conn', idpName: 'stub',
  });
  const done = await login.complete({ state: begun.state, code, ip: '198.51.100.1' });
  const cookie = `cre_session=${encodeURIComponent(done.token)}`;
  const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
  const call = (p, init = {}) => fetch(`${base}${p}`, {
    ...init,
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      ...(init.method && !['GET', 'HEAD'].includes(init.method)
        ? { 'x-csrf-token': me.csrfToken } : {}),
      ...(init.headers || {}),
    },
  });
  return { cookie, call, me };
}

/** Fetch the archive and parse it. Also returns the raw text, because some
 *  claims are about bytes rather than about the parsed object. */
async function archive(client) {
  const res = await client.call('/api/export');
  assert.equal(res.status, 200, `export failed: ${res.status}`);
  const text = await res.text();
  return { res, text, body: JSON.parse(text) };
}

const countExports = async () => (await ownerQuery(
  "SELECT count(*)::int AS n FROM audit_log WHERE action = 'tenant.exported'")).rows[0].n;

// ─── Who may call it ─────────────────────────────────────────────────────────

test('an unauthenticated export is refused', async () => {
  const r = await fetch(`${base}/api/export`);
  assert.equal(r.status, 401);
});

test('an analyst and a VP cannot export; an admin can', async () => {
  // The whole firm's history in one file, including everyone's activity. That
  // is an owner's decision, not a team member's.
  await setRole(seed.b.tenantId, 'analyst@firmy.com', 'analyst');
  assert.equal((await (await signIn('org_y', 'analyst@firmy.com')).call('/api/export')).status, 403);

  await setRole(seed.b.tenantId, 'analyst@firmy.com', 'vp');
  assert.equal((await (await signIn('org_y', 'analyst@firmy.com')).call('/api/export')).status, 403);

  await setRole(seed.b.tenantId, 'analyst@firmy.com', 'admin');
  assert.equal((await (await signIn('org_y', 'analyst@firmy.com')).call('/api/export')).status, 200);
});

// ─── What it contains ────────────────────────────────────────────────────────

test('the archive carries every section, a manifest and a completion marker', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const { body, res } = await archive(x);

  assert.equal(body.manifest.schemaVersion, 1);
  assert.equal(body.manifest.tenant.slug, 'firm-x');
  assert.equal(body.manifest.exportedBy.email, 'analyst@firmx.com');
  assert.ok(body.manifest.exportId);
  for (const key of ['deals', 'users', 'firmDefaults', 'auditLog']) {
    assert.ok(Array.isArray(body[key]), `${key} is missing from the archive`);
    assert.equal(body.counts[key], body[key].length, `${key} count disagrees with its rows`);
  }
  // Absent, this is a truncated transfer rather than an archive.
  assert.equal(body.complete, true);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="firm-x-export-\d{4}-\d{2}-\d{2}\.json"/);
});

test('it streams rather than buffering the whole archive first', async () => {
  // A buffered response knows its own length. A streamed one cannot, so the
  // absence of Content-Length is the observable difference — and the reason an
  // admin with years of deals cannot use this endpoint to exhaust the task.
  const x = await signIn('org_x', 'analyst@firmx.com');
  const res = await x.call('/api/export');
  assert.equal(res.headers.get('content-length'), null,
    'the archive was buffered before sending');
  assert.match(res.headers.get('content-type'), /application\/json/);
  await res.text();
});

test('soft-deleted deals are included and MARKED, not dropped', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const made = await (await x.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Withdrawn Tower', payload: { purchasePrice: 5 } }),
  })).json();
  assert.equal((await x.call(`/api/deals/${made.deal.id}`, { method: 'DELETE' })).status, 204);
  // Gone from the live list, which is what makes the next assertion meaningful.
  const live = await (await x.call('/api/deals')).json();
  assert.ok(!live.deals.some((d) => d.id === made.deal.id));

  const { body } = await archive(x);
  const row = body.deals.find((d) => d.id === made.deal.id);
  assert.ok(row, 'a deleted deal was dropped from the archive the firm is owed');
  assert.equal(row.deleted, true);
  assert.ok(row.deletedAt, 'the deletion is marked but not dated');
  assert.equal(row.payload.purchasePrice, 5);

  const kept = body.deals.find((d) => d.id === seed.a.dealId);
  assert.equal(kept.deleted, false);
  assert.equal(kept.deletedAt, null);
});

test('deal payloads arrive decrypted, and no ciphertext appears anywhere', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  await x.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({ name: 'Readable', payload: { sponsor: 'Northgate Partners', irr: 0.183 } }),
  });
  const { body, text } = await archive(x);
  const row = body.deals.find((d) => d.name === 'Readable');
  assert.equal(row.payload.sponsor, 'Northgate Partners');
  assert.equal(row.payload.irr, 0.183);
  assert.ok(!('payload_ct' in row), 'the ciphertext column reached the archive');
  assert.ok(!text.includes('payload_ct'));
});

test('users, firm defaults and the audit trail are all in it', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  const { body } = await archive(x);
  assert.ok(body.users.some((u) => u.email === 'analyst@firmx.com'));
  assert.ok(body.users.every((u) => u.tenant_id === undefined || u.tenant_id === seed.a.tenantId));
  assert.ok(body.firmDefaults.some((f) => f.version === '2026.1'));
  assert.ok(body.auditLog.some((a) => a.action === 'deal.created'));
});

test('one firm\'s archive contains nothing of the other\'s', async () => {
  // Row level security scopes every cursor, so the route carries no tenant
  // predicate. This is the check that the payoff actually arrived.
  const y = await signIn('org_y', 'analyst@firmy.com');
  const { body, text } = await archive(y);

  assert.ok(!body.deals.some((d) => d.id === seed.a.dealId));
  assert.ok(!body.users.some((u) => u.email === 'analyst@firmx.com'));
  assert.ok(!text.includes('Northgate Partners'), 'another firm\'s deal terms are in this archive');
  assert.ok(!text.includes('firmx.com'));
  assert.ok(body.deals.some((d) => d.id === seed.b.dealId), 'its own deal is missing');
});

test('platform audit entries belong to no tenant and reach no archive', async () => {
  await ownerQuery(
    `INSERT INTO audit_log (tenant_id, actor_kind, actor_ref, action, subject_type, subject_id)
     VALUES (NULL, 'operator', 'ops', 'tenant.suspended', 'tenant', 'some-other-firm')`);
  const x = await signIn('org_x', 'analyst@firmx.com');
  const { body, text } = await archive(x);
  assert.ok(!body.auditLog.some((a) => a.action === 'tenant.suspended'));
  assert.ok(!text.includes('some-other-firm'));
});

// ─── The audit entry, and when it is written ─────────────────────────────────

test('the archive contains the audit entry for its own creation', async () => {
  // A deterministic proof of ordering that needs no timing: the streaming
  // transaction can only see that row if it was COMMITTED before the snapshot
  // was taken — that is, before a byte was sent. Move the audit write after the
  // stream and this row cannot exist.
  const x = await signIn('org_x', 'analyst@firmx.com');
  const { body } = await archive(x);
  const own = body.auditLog.find(
    (a) => a.action === 'tenant.exported' && a.detail?.exportId === body.manifest.exportId);
  assert.ok(own, 'the export did not record itself before streaming');
  assert.equal(own.actor_kind, 'user');
  assert.deepEqual(own.detail.sections, ['deals', 'users', 'firmDefaults', 'auditLog']);
});

test('an export abandoned mid-transfer is STILL recorded', async () => {
  // The incident that matters. Whatever reached the wire was disclosed, and an
  // entry written on success would be missing from exactly this case.
  const x = await signIn('org_x', 'analyst@firmx.com');
  const before = await countExports();

  const ac = new AbortController();
  const res = await fetch(`${base}/api/export`, {
    headers: { cookie: x.cookie, origin: 'http://localhost:3000' },
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  // Headers are on the wire; the body is never read.
  ac.abort();
  await res.body?.cancel().catch(() => {});

  assert.equal(await countExports(), before + 1,
    'an export that was abandoned left no trace');
});

test('a refused export records nothing', async () => {
  // The other direction: the log must not fill with exports that never happened.
  await setRole(seed.b.tenantId, 'analyst@firmy.com', 'analyst');
  const before = await countExports();
  const y = await signIn('org_y', 'analyst@firmy.com');
  assert.equal((await y.call('/api/export')).status, 403);
  assert.equal(await countExports(), before);
  await setRole(seed.b.tenantId, 'analyst@firmy.com', 'admin');
});

test('exporting does not break the audit hash chain', async () => {
  const x = await signIn('org_x', 'analyst@firmx.com');
  await archive(x);
  const broken = await ownerQuery('SELECT broken_at, reason FROM audit_log_verify()');
  assert.deepEqual(broken.rows, [], `chain broken: ${JSON.stringify(broken.rows)}`);
});

// ─── Denial of service ───────────────────────────────────────────────────────

test('repeated exports are throttled', async () => {
  // One call reads every row the tenant owns and holds a pooled connection for
  // the length of the transfer. An admin account that can do that in a loop is
  // an outage anyone inside the firm can trigger.
  rateLimitMod.__reset();
  const x = await signIn('org_x', 'analyst@firmx.com');
  const codes = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await x.call('/api/export');
    codes.push(r.status);
    await r.text().catch(() => {});
  }
  assert.ok(codes.includes(429), `no request was throttled: ${codes.join(',')}`);
  assert.equal(codes[0], 200, 'the first export was throttled');
});

test('an encrypted deal past the first FETCH batch still exports readable', async () => {
  // THE BUG THIS PINS. The key lookup was latched on the first batch:
  //
  //     if (section.key === 'deals' && !keyState) { keyState = await keyFor(...) }
  //
  // keyFor() returns a TRUTHY {key: null, keyError: null} when no row in the
  // batch needs a key, so after one batch of plaintext rows `!keyState` was
  // false forever and the tenant key was never fetched. Every encrypted deal
  // outside the first 200 rows exported as payload: null — while the archive
  // still ended "complete": true.
  //
  // That is the DEFAULT state of an existing tenant between the 005 deploy and
  // the backfill: legacy plaintext rows sort first, so the newly encrypted
  // deals are precisely the ones past the boundary. A portability archive
  // silently missing the models it exists to deliver.
  //
  // The suite could not catch it because every other test has fewer than 200
  // deals. This one crosses the boundary on purpose.
  const x = await signIn('org_x', 'analyst@firmx.com');

  const created = await x.call('/api/deals', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Encrypted Tower', stage: 'Screening',
      payload: { purchasePrice: 4242424, note: 'CANARY' },
    }),
  });
  assert.equal(created.status, 201);
  const { deal } = await created.json();

  // Legacy plaintext rows, backdated so they sort ahead of the encrypted one —
  // exactly how a pre-005 tenant looks. Written as the owner because the app
  // role can no longer write a plaintext payload directly.
  const owner = new Client({ connectionString: env.ownerUrl });
  await owner.connect();
  try {
    await owner.query(
      `INSERT INTO deals (tenant_id, name, stage, payload, created_by, created_at)
       SELECT $1, 'Legacy ' || g, 'Screening', '{"purchasePrice":1}'::jsonb, $2,
              now() - interval '400 days' + (g * interval '1 minute')
         FROM generate_series(1, 250) g`,
      [seed.a.tenantId, seed.a.userId],
    );
    const shapes = await owner.query(
      `SELECT count(*) FILTER (WHERE payload IS NOT NULL)::int AS plaintext,
              count(*) FILTER (WHERE payload_ct IS NOT NULL)::int AS encrypted
         FROM deals WHERE tenant_id = $1`,
      [seed.a.tenantId],
    );
    assert.ok(shapes.rows[0].plaintext > 200,
      'the fixture must cross the FETCH boundary or it proves nothing');
    assert.ok(shapes.rows[0].encrypted >= 1);
  } finally {
    await owner.end();
  }

  const res = await x.call('/api/export');
  assert.equal(res.status, 200);
  const archive = JSON.parse(await res.text());

  const exported = archive.deals.find((d) => d.id === deal.id);
  assert.ok(exported, 'the encrypted deal is missing from the archive entirely');
  assert.equal(exported.payloadError, undefined,
    `the archive reported the payload unreadable: ${exported.payloadError}`);
  assert.deepEqual(exported.payload, { purchasePrice: 4242424, note: 'CANARY' },
    'the encrypted payload did not survive the export');

  // And the archive still claims completeness, which is only honest now.
  assert.equal(archive.complete, true);
  assert.ok(archive.counts.deals > 250);
});
