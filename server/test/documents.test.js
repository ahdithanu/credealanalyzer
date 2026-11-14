'use strict';

/**
 * Document intake: POST/GET /api/deals/:dealId/documents, over real HTTP and a
 * real Postgres, two tenants signed in at once.
 *
 * Every PDF here is a TEST FIXTURE built in test/fixtures/pdf.js. None is a
 * real document, and the strings in them are there only so a test can check
 * that text put on page N comes back on page N.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');
const fixtures = require('./fixtures/pdf');

process.env.SSO_PROVIDER = 'stub';
process.env.KEY_PROVIDER = 'local';
process.env.LOCAL_MASTER_KEY = 'test-master-key-for-the-documents-suite-0123';

let env, seed, server, base, login, brokerMod, stub, pool, documents;

const PAGE1 = ['FIXTURE Net Operating Income 1,234,567', 'FIXTURE Cap Rate 6.25%'];
const PAGE2 = ['FIXTURE second page'];
const FILENAME = 'Fixture OM, 400 Main St (caf\u00e9).pdf';

test.before(async () => {
  env = await freshDatabase('documents');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  process.env.DATABASE_MIGRATION_URL = env.migrationUrl;
  process.env.APP_ORIGIN = 'http://localhost:3000';
  login = require('../src/auth/login');
  brokerMod = require('../src/auth/broker');
  pool = require('../src/db/pool');
  documents = require('../src/routes/documents');
  stub = brokerMod.broker();
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

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
  const call = (path, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: {
      cookie,
      origin: 'http://localhost:3000',
      ...(init.method && !['GET', 'HEAD'].includes(init.method) ? { 'x-csrf-token': me.csrfToken } : {}),
      ...(init.headers || {}),
    },
  });
  const upload = (dealId, body, { filename = FILENAME, type = 'application/pdf' } = {}) => call(
    `/api/deals/${dealId}/documents`, {
      method: 'POST',
      body,
      headers: {
        ...(type ? { 'content-type': type } : {}),
        ...(filename !== null ? { 'x-filename': encodeURIComponent(filename) } : {}),
      },
    });
  return { call, upload, me };
}

async function setRole(tenantId, email, role) {
  await pool.withTenant(tenantId, null, (db) =>
    db.query('UPDATE users SET role = $1 WHERE email = $2', [role, email]));
}

async function superQuery(sql, params) {
  const c = new Client({ connectionString: env.ownerUrl });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

const X = () => signIn('org_x', 'analyst@firmx.com');
const Y = () => signIn('org_y', 'analyst@firmy.com');

let uploaded; // the text fixture's metadata, shared by later tests

test('upload stores per-page text and returns the metadata', async () => {
  const x = await X();
  const pdf = fixtures.textPdf([PAGE1, PAGE2]);
  const r = await x.upload(seed.a.dealId, pdf);
  assert.equal(r.status, 201);
  uploaded = await r.json();
  assert.equal(uploaded.dealId, seed.a.dealId);
  assert.equal(uploaded.filename, FILENAME);
  assert.equal(uploaded.sha256, crypto.createHash('sha256').update(pdf).digest('hex'));
  assert.equal(uploaded.byteSize, pdf.length);
  assert.equal(uploaded.pageCount, 2);
  assert.equal(uploaded.textLayer, 'present');
  assert.ok(!Number.isNaN(Date.parse(uploaded.createdAt)));
  assert.equal(uploaded.pages, undefined, 'the upload response carries no page text');
});

test('GET one returns contract C1 with the page text, line breaks kept', async () => {
  const x = await X();
  const r = await x.call(`/api/deals/${seed.a.dealId}/documents/${uploaded.id}`);
  assert.equal(r.status, 200);
  const doc = await r.json();
  assert.deepStrictEqual(Object.keys(doc).sort(), [
    'byteSize', 'createdAt', 'dealId', 'filename', 'id', 'pageCount', 'pages', 'sha256', 'textLayer',
  ]);
  assert.deepStrictEqual(doc.pages, [
    { page: 1, text: PAGE1.join('\n') },
    { page: 2, text: PAGE2.join('\n') },
  ]);
  assert.equal(doc.id, uploaded.id);
});

test('GET list returns metadata only', async () => {
  const x = await X();
  const r = await x.call(`/api/deals/${seed.a.dealId}/documents`);
  assert.equal(r.status, 200);
  const { documents: list } = await r.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, uploaded.id);
  assert.equal(list[0].filename, FILENAME);
  assert.equal(list[0].pages, undefined);
});

test('a PDF with no text layer is stored as absent with empty pages, not invented text', async () => {
  const x = await X();
  const r = await x.upload(seed.a.dealId, fixtures.noTextPdf(3), { filename: 'fixture-scan.pdf' });
  assert.equal(r.status, 201);
  const meta = await r.json();
  assert.equal(meta.textLayer, 'absent');
  assert.equal(meta.pageCount, 3);
  const doc = await (await x.call(`/api/deals/${seed.a.dealId}/documents/${meta.id}`)).json();
  assert.deepStrictEqual(doc.pages, [1, 2, 3].map((page) => ({ page, text: '' })));
});

test('the same file twice on one deal is a 409 naming the first copy', async () => {
  const x = await X();
  const r = await x.upload(seed.a.dealId, fixtures.textPdf([PAGE1, PAGE2]));
  assert.equal(r.status, 409);
  assert.deepStrictEqual(await r.json(), { error: 'duplicate', documentId: uploaded.id });
});

test('another firm cannot upload to, list, or read a deal\'s documents: 404, never 403', async () => {
  const y = await Y();
  const up = await y.upload(seed.a.dealId, fixtures.textPdf([['FIXTURE planted']]));
  assert.equal(up.status, 404);
  const list = await y.call(`/api/deals/${seed.a.dealId}/documents`);
  assert.equal(list.status, 404);
  const one = await y.call(`/api/deals/${seed.a.dealId}/documents/${uploaded.id}`);
  assert.equal(one.status, 404);
  // Its own deal id with the other firm's document id: still nothing.
  const swapped = await y.call(`/api/deals/${seed.b.dealId}/documents/${uploaded.id}`);
  assert.equal(swapped.status, 404);
  // And nothing was written for firm X by firm Y.
  const { rows } = await superQuery('SELECT count(*)::int AS n FROM deal_documents WHERE tenant_id = $1', [seed.b.tenantId]);
  assert.equal(rows[0].n, 0);
});

test('a malformed deal or document id is a 404, not a 500', async () => {
  const x = await X();
  assert.equal((await x.call('/api/deals/not-a-uuid/documents')).status, 404);
  assert.equal((await x.call(`/api/deals/${seed.a.dealId}/documents/nope`)).status, 404);
  assert.equal((await x.upload('not-a-uuid', fixtures.textPdf([['x']]))).status, 404);
});

test('a reader (ic) cannot upload but can list and read', async () => {
  await setRole(seed.a.tenantId, 'analyst@firmx.com', 'ic');
  try {
    const x = await X();
    const r = await x.upload(seed.a.dealId, fixtures.textPdf([['FIXTURE ic attempt']]));
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'forbidden');
    assert.equal((await x.call(`/api/deals/${seed.a.dealId}/documents`)).status, 200);
    assert.equal((await x.call(`/api/deals/${seed.a.dealId}/documents/${uploaded.id}`)).status, 200);
  } finally {
    await setRole(seed.a.tenantId, 'analyst@firmx.com', 'analyst');
  }
});

test('an upload without the CSRF token is refused', async () => {
  const x = await X();
  const r = await x.call(`/api/deals/${seed.a.dealId}/documents`, {
    method: 'POST', body: fixtures.textPdf([['x']]),
    headers: { 'content-type': 'application/pdf', 'x-filename': 'a.pdf', 'x-csrf-token': 'wrong' },
  });
  assert.equal(r.status, 403);
});

test('a non-PDF is refused by its bytes, whatever the Content-Type says', async () => {
  const x = await X();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const r = await x.upload(seed.a.dealId, png, { filename: 'fixture.pdf' });
  assert.equal(r.status, 415);
  assert.equal((await r.json()).error, 'not_pdf');
});

test('a body that is not declared application/pdf is refused', async () => {
  const x = await X();
  const r = await x.upload(seed.a.dealId, fixtures.textPdf([['x']]), { type: 'application/octet-stream' });
  assert.equal(r.status, 415);
  assert.equal((await r.json()).error, 'unsupported_media_type');
});

test('an empty body is refused', async () => {
  const x = await X();
  const r = await x.upload(seed.a.dealId, Buffer.alloc(0));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'empty');
});

test('an upload without a filename is refused', async () => {
  const x = await X();
  const r = await x.upload(seed.a.dealId, fixtures.textPdf([['FIXTURE nameless']]), { filename: null });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'filename_required');
});

test('filenames keep the last path segment and refuse control characters', () => {
  assert.equal(documents.parseFilename(encodeURIComponent('C:\\Users\\a\\memo.pdf')), 'memo.pdf');
  assert.equal(documents.parseFilename(encodeURIComponent('../../etc/memo.pdf')), 'memo.pdf');
  assert.equal(documents.parseFilename(encodeURIComponent('a\nb.pdf')), null);
  assert.equal(documents.parseFilename('%E0%A4%A'), null);
  assert.equal(documents.parseFilename(encodeURIComponent('x'.repeat(256))), null);
  assert.equal(documents.parseFilename(undefined), null);
});

test('a body over the 25MB ceiling is refused with 413', async () => {
  assert.equal(documents.MAX_BYTES, 25 * 1024 * 1024);
  const x = await X();
  const big = Buffer.alloc(documents.MAX_BYTES + 1, 0x20);
  big.write('%PDF-1.4\n', 0, 'latin1');
  const r = await x.upload(seed.a.dealId, big);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'too_large');
});

test('the global JSON limit is still 1MB: the PDF ceiling did not leak to other routes', async () => {
  const x = await X();
  const r = await x.call('/api/deals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'big', payload: { pad: 'x'.repeat(1100 * 1024) } }),
  });
  assert.equal(r.status, 413);
});

test('a password-protected PDF is a 422 naming the reason', async () => {
  const x = await X();
  const r = await x.upload(seed.a.dealId, fixtures.encryptedPdf(), { filename: 'fixture-locked.pdf' });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, 'pdf_encrypted');
});

test('a corrupt PDF is a 422', async () => {
  const x = await X();
  const r = await x.upload(seed.a.dealId, fixtures.corruptPdf(), { filename: 'fixture-broken.pdf' });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, 'pdf_unreadable');
});

test('the upload is audited, with counts and without the file name', async () => {
  const { rows } = await superQuery(
    `SELECT tenant_id, actor_user_id, subject_type, detail FROM audit_log
      WHERE action = 'document.uploaded' AND subject_id = $1`, [uploaded.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, seed.a.tenantId);
  assert.equal(rows[0].actor_user_id, seed.a.userId);
  assert.equal(rows[0].subject_type, 'document');
  assert.deepStrictEqual(rows[0].detail, {
    dealId: seed.a.dealId, byteSize: uploaded.byteSize, pageCount: 2, textLayer: 'present',
  });
  assert.ok(!JSON.stringify(rows[0].detail).includes('Fixture OM'));
});

test('at rest, the page text and the filename are sealed and the PDF bytes are not kept', async () => {
  const { rows } = await superQuery(
    'SELECT * FROM deal_documents WHERE id = $1', [uploaded.id]);
  const row = rows[0];
  const all = Buffer.concat(Object.values(row)
    .filter((v) => v !== null)
    .map((v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'))));
  assert.ok(!all.includes('FIXTURE Net Operating Income'), 'page text stored in the clear');
  assert.ok(!all.includes('Fixture OM'), 'filename stored in the clear');
  assert.ok(!all.includes('%PDF-'), 'raw PDF bytes stored');
  assert.equal(row.uploaded_by, seed.a.userId);
});

test('deal_documents has RLS enabled and forced, and is not owned by the app role', async () => {
  const { rows } = await superQuery(
    `SELECT relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner
       FROM pg_class WHERE relname = 'deal_documents'`);
  assert.equal(rows[0].relrowsecurity, true);
  assert.equal(rows[0].relforcerowsecurity, true);
  assert.notEqual(rows[0].owner, 'app_user');
});

test('the database refuses a document stamped with my tenant on another firm\'s deal', async () => {
  // Foreign keys bypass row level security, so a single-column key on deal_id
  // would accept this row: my tenant id passes the policy, and the other
  // firm's deal id passes the key. The composite key is what refuses it.
  const app = new Client({ connectionString: env.appUrl });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.current_tenant', $1, true)", [seed.a.tenantId]);
    await assert.rejects(() => app.query(
      `INSERT INTO deal_documents (tenant_id, deal_id, filename_ct, pages_ct, sha256, byte_size, page_count, text_layer)
       VALUES ($1,$2,'\\x00','\\x00',$3,1,0,'absent')`,
      [seed.a.tenantId, seed.b.dealId, 'a'.repeat(64)]), /foreign key/i);
  } finally {
    await app.query('ROLLBACK').catch(() => {});
    await app.end();
  }
});

test('a tenant sees only its own documents at the database, whatever it names', async () => {
  const app = new Client({ connectionString: env.appUrl });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.current_tenant', $1, true)", [seed.b.tenantId]);
    const r = await app.query('SELECT id FROM deal_documents');
    assert.equal(r.rows.length, 0);
    await app.query('ROLLBACK');
    const none = await app.query('SELECT id FROM deal_documents');
    assert.equal(none.rows.length, 0, 'no tenant context must see nothing');
  } finally {
    await app.end();
  }
});

test('the CORS preflight allows the X-Filename header the client sends', async () => {
  const r = await fetch(`${base}/api/deals/${seed.a.dealId}/documents`, {
    method: 'OPTIONS', headers: { origin: 'http://localhost:3000' },
  });
  assert.match(r.headers.get('access-control-allow-headers'), /\bx-filename\b/);
});

test('documents of a soft-deleted deal are not reachable', async () => {
  const x = await X();
  const created = await (await x.call('/api/deals', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Fixture deal to delete', payload: {} }),
  })).json();
  const dealId = created.deal.id;
  const up = await x.upload(dealId, fixtures.textPdf([['FIXTURE soon gone']]));
  assert.equal(up.status, 201);
  const doc = await up.json();
  await setRole(seed.a.tenantId, 'analyst@firmx.com', 'vp');
  try {
    const vp = await X();
    assert.equal((await vp.call(`/api/deals/${dealId}`, { method: 'DELETE' })).status, 204);
    assert.equal((await vp.call(`/api/deals/${dealId}/documents`)).status, 404);
    assert.equal((await vp.call(`/api/deals/${dealId}/documents/${doc.id}`)).status, 404);
    assert.equal((await vp.upload(dealId, fixtures.textPdf([['FIXTURE late']]))).status, 404);
  } finally {
    await setRole(seed.a.tenantId, 'analyst@firmx.com', 'analyst');
  }
});

test('offboarding a tenant deletes its documents and counts them', async () => {
  const y = await Y();
  assert.equal((await y.upload(seed.b.dealId, fixtures.textPdf([['FIXTURE firm y page']]))).status, 201);
  const retention = require('../src/admin/retention');
  const plan = await retention.offboard({ slug: 'firm-y', log: () => {} });
  assert.equal(plan.documents, 1);
  const done = await retention.offboard({ slug: 'firm-y', apply: true, reason: 'FIXTURE-1', log: () => {} });
  assert.equal(done.documents, 1);
  const { rows } = await superQuery('SELECT count(*)::int AS n FROM deal_documents WHERE tenant_id = $1', [seed.b.tenantId]);
  assert.equal(rows[0].n, 0);
  const entry = await superQuery(
    "SELECT detail FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.offboarded'", [seed.b.tenantId]);
  assert.equal(entry.rows[0].detail.documentsDeleted, 1);
});

test('once the tenant key is destroyed, text is 410 and names are null, never placeholders', async () => {
  // Run last: it destroys firm X's key the way offboarding does.
  await superQuery(
    'UPDATE tenant_keys SET wrapped_key = NULL, destroyed_at = now(), destroyed_by = $2 WHERE tenant_id = $1',
    [seed.a.tenantId, 'FIXTURE']);
  const x = await X();
  const one = await x.call(`/api/deals/${seed.a.dealId}/documents/${uploaded.id}`);
  assert.equal(one.status, 410);
  assert.deepStrictEqual(await one.json(), { error: 'key_destroyed' });
  const { documents: list } = await (await x.call(`/api/deals/${seed.a.dealId}/documents`)).json();
  const mine = list.find((d) => d.id === uploaded.id);
  assert.equal(mine.filename, null);
  assert.equal(mine.filenameError, 'key_destroyed');
});
