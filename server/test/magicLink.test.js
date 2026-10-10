'use strict';

/**
 * Email sign-in links, attacked.
 *
 * The magic-link path has strictly less to work with than the SSO path: no
 * assertion, no organization id, no IdP. The verified email domain is the
 * ONLY thing binding an address to a firm. So most of what follows is not a
 * happy path with assertions bolted on — it is the list of ways that single
 * binding can be made to admit the wrong person, each one closed.
 *
 * The test that matters most is "a firm requiring MFA cannot be entered by a
 * link". Enabling this feature must not quietly become the way to skip the
 * second factor.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { freshDatabase, seedTwoTenants } = require('./helpers');

process.env.SSO_PROVIDER = 'stub';
process.env.MAIL_PROVIDER = 'stub';

let env, seed, login, magicLink, mailerMod, pool, owner;

test.before(async () => {
  env = await freshDatabase('magiclink');
  seed = await seedTwoTenants(env.ownerUrl);
  process.env.DATABASE_URL = env.appUrl;
  process.env.AUTH_DATABASE_URL = env.authUrl;
  // Required after the URLs are set: config and pool capture them on load.
  login = require('../src/auth/login');
  magicLink = require('../src/auth/magicLink');
  mailerMod = require('../src/auth/mailer');
  pool = require('../src/db/pool');

  owner = new Client({ connectionString: env.ownerUrl });
  await owner.connect();
  // Firm X opts in. Firm Y does not, and is the control: every "is this
  // tenant allowed" assertion below has a live counter-example sitting next
  // to it rather than a mutated copy of the same row.
  await owner.query(`UPDATE tenants SET auth_methods = ARRAY['sso','magic_link'] WHERE slug = 'firm-x'`);
});

test.after(async () => {
  if (owner) await owner.end();
  if (pool) { await pool.pool.end(); await pool.authPool.end(); }
  if (env) await env.drop();
});

/**
 * Both the captured mail AND the links table, because the per-address throttle
 * counts rows in the last hour and those rows outlive a single case. Leaving
 * them in place made every test after the fifth fail with "no mail was sent" —
 * the throttle working exactly as intended, on the test suite.
 */
test.beforeEach(async () => {
  mailerMod.__resetMail();
  if (owner) await owner.query('DELETE FROM login_links');
});

/** The token out of the most recently mailed link. */
function mailedToken() {
  const last = mailerMod.sent[mailerMod.sent.length - 1];
  assert.ok(last, 'no mail was sent');
  const m = last.text.match(/token=([A-Za-z0-9_-]+)/);
  assert.ok(m, `no token in the mail body:\n${last.text}`);
  return m[1];
}

const ctx = { ip: '203.0.113.10', userAgent: 'test' };

// ─── The path works at all ───────────────────────────────────────────────────

test('a verified address on an opted-in firm is mailed a link that signs them in', async () => {
  const r = await magicLink.issue({ email: 'analyst@firmx.com', redirectTo: '/pipeline', ...ctx });
  assert.deepStrictEqual(r, { sent: true });
  assert.strictEqual(mailerMod.sent.length, 1);
  assert.strictEqual(mailerMod.sent[0].to, 'analyst@firmx.com');

  // Drive the token out of the MAIL, not out of the database. A link that is
  // correct in login_links and wrong in the message is a login that does not
  // work, and only this assertion can tell the difference.
  const out = await login.completeMagicLink({ token: mailedToken(), ...ctx });
  assert.strictEqual(out.kind, 'session');
  assert.strictEqual(out.tenant.slug, 'firm-x');
  assert.strictEqual(out.user.email, 'analyst@firmx.com');
  assert.strictEqual(out.redirectTo, '/pipeline');
});

test('the session records that no identity provider asserted a factor', async () => {
  await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
  await login.completeMagicLink({ token: mailedToken(), ...ctx });
  const { rows } = await owner.query(
    `SELECT auth_method, mfa_asserted, mfa_factor FROM sessions ORDER BY issued_at DESC LIMIT 1`,
  );
  assert.strictEqual(rows[0].auth_method, 'magic_link');
  // false, not null: a mailed link is positive evidence that no IdP asserted
  // anything, which is a different statement from "we were not told".
  assert.strictEqual(rows[0].mfa_asserted, false);
  assert.strictEqual(rows[0].mfa_factor, null);
});

test('an unknown person is provisioned just in time, into the right tenant', async () => {
  await magicLink.issue({ email: 'newhire@firmx.com', ...ctx });
  const out = await login.completeMagicLink({ token: mailedToken(), ...ctx });
  assert.strictEqual(out.user.email, 'newhire@firmx.com');
  const { rows } = await owner.query(
    `SELECT tenant_id, external_id FROM users WHERE email = $1`, ['newhire@firmx.com'],
  );
  assert.strictEqual(rows[0].tenant_id, seed.a.tenantId);
  // No IdP subject exists on this path; writing one would bind the account to
  // a value no directory issued.
  assert.strictEqual(rows[0].external_id, null);
});

// ─── The second factor cannot be skipped by using this door ──────────────────

test('a firm that requires MFA and has no Duo is NOT mailed a link', async () => {
  // The whole reason assertMagicLinkAllowed() exists. require_mfa is enforced
  // in login.complete() against the IdP's assertion, and that code never runs
  // on this path — so without the refusal, turning magic links on would
  // silently downgrade the firm's posture.
  await owner.query(`UPDATE tenants SET require_mfa = true WHERE slug = 'firm-x'`);
  try {
    const r = await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
    assert.deepStrictEqual(r, { sent: true }, 'the caller is told nothing');
    assert.strictEqual(mailerMod.sent.length, 0, 'but no link was sent');
  } finally {
    await owner.query(`UPDATE tenants SET require_mfa = NULL WHERE slug = 'firm-x'`);
  }
});

test('a link already in flight stops working the moment MFA is required', async () => {
  // A link lives fifteen minutes and a firm can change posture inside that
  // window. The check that counts is at admission, not at send.
  await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
  const token = mailedToken();
  await owner.query(`UPDATE tenants SET require_mfa = true WHERE slug = 'firm-x'`);
  try {
    await assert.rejects(
      () => login.completeMagicLink({ token, ...ctx }),
      (e) => e instanceof login.LoginError && e.code === 'mfa_required',
    );
  } finally {
    await owner.query(`UPDATE tenants SET require_mfa = NULL WHERE slug = 'firm-x'`);
  }
});

// ─── Only firms that opted in ────────────────────────────────────────────────

test('a firm that has not enabled the method is not mailed a link', async () => {
  const r = await magicLink.issue({ email: 'analyst@firmy.com', ...ctx });
  assert.deepStrictEqual(r, { sent: true });
  assert.strictEqual(mailerMod.sent.length, 0);
});

test('existing tenants default to SSO only, never opted in by the migration', async () => {
  const { rows } = await owner.query(`SELECT auth_methods FROM tenants WHERE slug = 'firm-y'`);
  assert.deepStrictEqual(rows[0].auth_methods, ['sso']);
});

test('a suspended firm is not mailed a link', async () => {
  await owner.query(`UPDATE tenants SET status = 'suspended' WHERE slug = 'firm-x'`);
  try {
    await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
    assert.strictEqual(mailerMod.sent.length, 0);
  } finally {
    await owner.query(`UPDATE tenants SET status = 'active' WHERE slug = 'firm-x'`);
  }
});

test('a link in flight stops working the moment the firm is suspended', async () => {
  await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
  const token = mailedToken();
  await owner.query(`UPDATE tenants SET status = 'suspended' WHERE slug = 'firm-x'`);
  try {
    await assert.rejects(
      () => login.completeMagicLink({ token, ...ctx }),
      (e) => e.code === 'tenant_suspended',
    );
  } finally {
    await owner.query(`UPDATE tenants SET status = 'active' WHERE slug = 'firm-x'`);
  }
});

// ─── The domain is the only binding, so it had better hold ───────────────────

test('an address on no verified domain is not mailed a link', async () => {
  await magicLink.issue({ email: 'someone@nowhere.example', ...ctx });
  assert.strictEqual(mailerMod.sent.length, 0);
});

test('a domain un-verified after the link was sent refuses the claim', async () => {
  // The tenant id is frozen into the link, so without re-checking the domain
  // an offboarded firm would still admit anyone holding an unexpired link.
  await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
  const token = mailedToken();
  await owner.query(
    `UPDATE tenant_domains SET verified_at = NULL WHERE tenant_id = $1`, [seed.a.tenantId],
  );
  try {
    await assert.rejects(
      () => login.completeMagicLink({ token, ...ctx }),
      (e) => e.code === 'domain_not_verified',
    );
  } finally {
    await owner.query(
      `UPDATE tenant_domains SET verified_at = now() WHERE tenant_id = $1`, [seed.a.tenantId],
    );
  }
});

test('the database refuses to verify one domain for two firms', async () => {
  await assert.rejects(
    () => owner.query(
      `INSERT INTO tenant_domains (tenant_id, domain, verified_at) VALUES ($1,$2,now())`,
      [seed.b.tenantId, 'firmx.com'],
    ),
    /tenant_domains_verified_unique|duplicate key/,
  );
});

test('and if that index were ever dropped, an ambiguous domain is still refused', async () => {
  // Defence in depth, asserted rather than claimed: the runtime check is what
  // makes the index a backstop instead of the only thing standing there.
  await owner.query('DROP INDEX tenant_domains_verified_unique');
  try {
    await owner.query(
      `INSERT INTO tenant_domains (tenant_id, domain, verified_at) VALUES ($1,$2,now())`,
      [seed.b.tenantId, 'firmx.com'],
    );
    await assert.rejects(
      () => magicLink.resolveTenantForEmail('analyst@firmx.com'),
      (e) => e.code === 'ambiguous_domain',
    );
    // And nothing is mailed, rather than a link to a guessed tenant.
    await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
    assert.strictEqual(mailerMod.sent.length, 0);
  } finally {
    await owner.query(`DELETE FROM tenant_domains WHERE tenant_id = $1 AND domain = 'firmx.com'`,
      [seed.b.tenantId]);
    await owner.query(`CREATE UNIQUE INDEX tenant_domains_verified_unique
      ON tenant_domains (lower(domain)) WHERE verified_at IS NOT NULL`);
  }
});

// ─── The token itself ────────────────────────────────────────────────────────

test('a link works exactly once', async () => {
  await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
  const token = mailedToken();
  await login.completeMagicLink({ token, ...ctx });
  await assert.rejects(
    () => login.completeMagicLink({ token, ...ctx }),
    (e) => e.code === 'link_invalid',
  );
});

test('the claim takes the row lock, so a concurrent click cannot also win', async () => {
  // A mail client prefetching the link while the human also opens it is the
  // ordinary case, not a contrived race.
  //
  // Firing two claims with Promise.allSettled does NOT test this — they
  // serialise often enough that a read-then-write implementation passes, which
  // mutation M5 demonstrated. So the contention is made deterministic: another
  // transaction holds the row's write lock, and the question is whether claim()
  // waits for it.
  //
  //   atomic UPDATE   blocks on the lock, re-reads after commit, sees
  //                   consumed_at set, and finds no row.
  //   SELECT-then-UPDATE  reads the still-visible old row immediately and
  //                   hands out a second login.
  await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
  const token = mailedToken();

  const other = new Client({ connectionString: env.ownerUrl });
  await other.connect();
  let settled = false;
  try {
    await other.query('BEGIN');
    await other.query(
      `UPDATE login_links SET consumed_at = now()
        WHERE token_hash = digest($1, 'sha256')`, [token],
    );

    const claiming = magicLink.claim(token).then(
      (v) => { settled = true; return v; },
      (e) => { settled = true; throw e; },
    );
    claiming.catch(() => {});           // the rejection is asserted below
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(settled, false,
      'claim() returned while another transaction held the row lock, so it read '
      + 'rather than claimed');

    await other.query('COMMIT');
    await assert.rejects(() => claiming, (e) => e.code === 'link_invalid');
  } finally {
    await other.query('ROLLBACK').catch(() => {});
    await other.end();
  }
});

test('an expired link is refused', async () => {
  await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
  const token = mailedToken();
  await owner.query(`UPDATE login_links SET expires_at = now() - interval '1 second'`);
  await assert.rejects(
    () => login.completeMagicLink({ token, ...ctx }),
    (e) => e.code === 'link_invalid',
  );
});

test('a forged token is refused', async () => {
  await assert.rejects(
    () => login.completeMagicLink({ token: 'not-a-real-token', ...ctx }),
    (e) => e.code === 'link_invalid',
  );
});

test('only a hash of the token is stored', async () => {
  await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
  const token = mailedToken();
  const { rows } = await owner.query(
    'SELECT token_hash FROM login_links ORDER BY created_at DESC LIMIT 1',
  );
  const storedBytes = rows[0].token_hash;

  // Compared as BYTES, deliberately. The first version of this test stringified
  // the row and looked for the token in the result, which cannot work: pg
  // returns bytea as a Buffer and JSON.stringify renders it as {type, data:[…]},
  // so the assertion passed just as happily with the raw token in the column.
  // A storage test that cannot see the thing it forbids is worse than none —
  // it reads as a guarantee. Mutation M12 is what surfaced it.
  assert.ok(!storedBytes.equals(Buffer.from(token)),
    'the raw token must not be what is stored');
  assert.ok(
    storedBytes.equals(crypto.createHash('sha256').update(token).digest()),
    'the stored value must be the sha256 of the token',
  );
});

// ─── Nothing is revealed to the caller ───────────────────────────────────────

test('the answer is byte-identical for a real address and an invented one', async () => {
  // Any difference here turns the endpoint into a customer list and a user
  // directory, enumerable one address at a time.
  const real = await magicLink.issue({ email: 'analyst@firmx.com', ...ctx });
  const fake = await magicLink.issue({ email: 'nobody@nowhere.example', ...ctx });
  const notOptedIn = await magicLink.issue({ email: 'analyst@firmy.com', ...ctx });
  const malformed = await magicLink.issue({ email: 'not-an-email', ...ctx });
  assert.deepStrictEqual(real, { sent: true });
  assert.deepStrictEqual(fake, { sent: true });
  assert.deepStrictEqual(notOptedIn, { sent: true });
  assert.deepStrictEqual(malformed, { sent: true });
});

test('an address is throttled independently of the source address', async () => {
  for (let i = 0; i < 5; i += 1) {
    await magicLink.issue({ email: 'analyst@firmx.com', ip: `198.51.100.${i}`, userAgent: 't' });
  }
  const before = mailerMod.sent.length;
  assert.strictEqual(before, 5, 'the first five, each from a different address, are sent');
  await magicLink.issue({ email: 'analyst@firmx.com', ip: '198.51.100.99', userAgent: 't' });
  assert.strictEqual(mailerMod.sent.length, before, 'the sixth from a fresh IP is still refused');
});

// ─── The redirect cannot be turned outward ───────────────────────────────────

test('an absolute redirect is dropped rather than honoured', async () => {
  // This value is echoed into a redirect AFTER the session cookie is set, so
  // an absolute URL here carries a freshly authenticated user to someone
  // else's site.
  await magicLink.issue({ email: 'analyst@firmx.com', redirectTo: 'https://evil.example/x', ...ctx });
  const out = await login.completeMagicLink({ token: mailedToken(), ...ctx });
  assert.strictEqual(out.redirectTo, '/');
});

test('a protocol-relative redirect is dropped too', async () => {
  // `//evil.example` is absolute to a browser and passes a naive startsWith('/').
  assert.strictEqual(magicLink.relativeRedirect('//evil.example'), null);
  assert.strictEqual(magicLink.relativeRedirect('/pipeline'), '/pipeline');
});

// ─── The request-path role cannot mint a login ───────────────────────────────

test('app_user cannot read or write login_links', async () => {
  const app = new Client({ connectionString: env.appUrl });
  await app.connect();
  try {
    await assert.rejects(() => app.query('SELECT * FROM login_links'), /permission denied/);
    await assert.rejects(
      () => app.query(`INSERT INTO login_links (token_hash, tenant_id, email, expires_at)
                       VALUES ('\\x00'::bytea, $1, 'x@firmx.com', now() + interval '1 hour')`,
      [seed.a.tenantId]),
      /permission denied/,
    );
  } finally { await app.end(); }
});

// ─── Turning it on is an audited, deliberate act ─────────────────────────────

test('the admin command enables a method and leaves an audit entry', async () => {
  const tenants = require('../src/admin/tenants');
  process.env.DATABASE_MIGRATION_URL = env.migrationUrl;
  const out = await tenants.setAuthMethods({ slug: 'firm-y', methods: 'sso,magic_link' });
  assert.deepStrictEqual(out.auth_methods, ['sso', 'magic_link']);

  const { rows } = await owner.query(
    `SELECT action, detail FROM audit_log WHERE action = 'tenant.auth_methods_set'`,
  );
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].detail.methods, ['sso', 'magic_link']);

  // And it took effect, rather than only writing a row.
  await magicLink.issue({ email: 'analyst@firmy.com', ...ctx });
  assert.strictEqual(mailerMod.sent.length, 1);

  await tenants.setAuthMethods({ slug: 'firm-y', methods: 'sso' });
});

test('an unknown method is refused rather than stored', async () => {
  const tenants = require('../src/admin/tenants');
  await assert.rejects(
    () => tenants.setAuthMethods({ slug: 'firm-y', methods: 'sso,passwrod' }),
    /unknown sign-in method\(s\): passwrod/,
  );
  // A typo stored verbatim would read as "configured" to whoever typed it and
  // as "not allowed" to the application, which is the worst of both.
  const { rows } = await owner.query(`SELECT auth_methods FROM tenants WHERE slug = 'firm-y'`);
  assert.deepStrictEqual(rows[0].auth_methods, ['sso']);
});

test('an empty method list is refused, because that is what suspend is for', async () => {
  const tenants = require('../src/admin/tenants');
  await assert.rejects(
    () => tenants.setAuthMethods({ slug: 'firm-y', methods: '' }),
    /--methods is required/,
  );
});
