'use strict';

/**
 * Provision a firm's Duo integration.
 *
 * Usage (DATABASE_MIGRATION_URL is the owner credential from Secrets Manager;
 * DUO_CONFIG_KEY seals the client secret):
 *
 *   node src/admin/duo.js status  [--slug firm-x]
 *   node src/admin/duo.js set     --slug firm-x --api-host api-xxxxxxxx.duosecurity.com \
 *                                 --client-id <20 chars> --client-secret <40 chars>
 *   node src/admin/duo.js check   --slug firm-x
 *   node src/admin/duo.js enable  --slug firm-x
 *   node src/admin/duo.js disable --slug firm-x
 *   node src/admin/duo.js failmode --slug firm-x --mode closed|open
 *
 * `set` does NOT enable the integration, and that separation is deliberate:
 * enabling Duo for a firm puts a second factor in front of every one of their
 * users, so the sequence is configure, prove it works against Duo, then turn it
 * on. `enable` refuses on a configuration that has never passed `check`.
 *
 * The client secret is read from the argument, sealed immediately, and never
 * written anywhere in the clear — not to the table, not to stdout, not to the
 * audit entry.
 */

const { Client } = require('pg');
const mfa = require('../auth/mfa');
const { DuoClient } = require('../auth/duo');
const config = require('../config');

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Accepts both `--slug=firm-x` and `--slug firm-x`.
 *
 * The second form is what the usage above documents and what every other admin
 * command in this directory takes — and the first version of this parser only
 * handled the first form, so every documented invocation silently parsed the
 * flag as `true` and the tool reported "no tenant with slug true". It ran, it
 * failed, and it failed with a message about the wrong thing.
 *
 * Hyphenated flags become camelCase keys, so `--api-host` fills `apiHost`.
 */
function parseArgs(argv) {
  const out = {};
  const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const eq = argv[i].indexOf('=');
    if (eq > -1) {
      out[camel(argv[i].slice(2, eq))] = argv[i].slice(eq + 1);
      continue;
    }
    const key = camel(argv[i].slice(2));
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? next : true;
    if (out[key] !== true) i += 1;
  }
  return out;
}

/** One connection as the owner, for the whole command. */
async function withOwner(fn) {
  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('set DATABASE_MIGRATION_URL to the owner credential');
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function tenantBySlug(db, slug) {
  if (!SLUG.test(String(slug || ''))) {
    throw new Error('--slug must be lowercase letters, digits and hyphens');
  }
  const { rows } = await db.query('SELECT id, slug, name FROM tenants WHERE slug = $1', [slug]);
  if (!rows[0]) throw new Error(`no tenant with slug ${slug}`);
  return rows[0];
}

/**
 * Record an administrative action. Best effort, like admin/tenants.js: an audit
 * write that fails must not roll back a change the operator believes succeeded.
 */
async function record(db, tenantId, action, detail) {
  const actorRef = process.env.ADMIN_ACTOR || process.env.SUDO_USER
    || process.env.USER || 'unknown';
  try {
    await db.query(
      `INSERT INTO audit_log (tenant_id, actor_kind, actor_ref, action, subject_type, detail)
       VALUES ($1, 'operator', $2, $3, 'duo', $4)`,
      [tenantId, actorRef, action, JSON.stringify(detail)],
    );
  } catch (err) {
    console.error(`WARNING: the action succeeded but was not audited: ${err.message}`);
  }
}

async function status({ slug } = {}) {
  return withOwner(async (db) => {
    const { rows } = await db.query(
      `SELECT t.slug, t.name, t.require_mfa,
              d.api_host, d.client_id, d.enabled, d.fail_mode, d.verified_at,
              d.client_secret_ct IS NOT NULL AS has_secret
         FROM tenants t LEFT JOIN tenant_duo d ON d.tenant_id = t.id
        ${slug ? 'WHERE t.slug = $1' : ''}
        ORDER BY t.slug`,
      slug ? [slug] : [],
    );
    // The secret is reported as present or absent, never shown, and the
    // ciphertext is not returned either — a base64 blob in a terminal is a
    // secret in a scrollback buffer waiting for the right key.
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      idpAssertedMfaRequired: r.require_mfa,
      duo: r.api_host ? {
        apiHost: r.api_host,
        clientId: r.client_id,
        secretStored: r.has_secret,
        enabled: r.enabled,
        failMode: r.fail_mode,
        // Never health-checked is reported distinctly from checked-and-failing.
        verifiedAt: r.verified_at,
      } : null,
    }));
  });
}

async function set({ slug, apiHost, clientId, clientSecret }) {
  if (!apiHost || !clientId || !clientSecret) {
    throw new Error('--api-host, --client-id and --client-secret are all required');
  }
  // Constructed before anything is written, so a malformed api_host or a
  // truncated secret is refused here rather than discovered by a user at a
  // login prompt. Uses the real validation, not a copy of it.
  new DuoClient({
    apiHost, clientId, clientSecret, redirectUri: config.duo.redirectUri,
  });

  return withOwner(async (db) => {
    const tenant = await tenantBySlug(db, slug);
    const sealed = mfa.sealSecret(tenant.id, clientSecret);
    await db.query(
      `INSERT INTO tenant_duo (tenant_id, api_host, client_id, client_secret_ct, updated_at)
            VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (tenant_id) DO UPDATE
            SET api_host = EXCLUDED.api_host,
                client_id = EXCLUDED.client_id,
                client_secret_ct = EXCLUDED.client_secret_ct,
                updated_at = now(),
                -- A changed credential is an unproven credential. Clearing
                -- this forces another health check before enable accepts it.
                verified_at = NULL`,
      [tenant.id, apiHost, clientId, sealed],
    );
    await record(db, tenant.id, 'duo.configured', { apiHost, clientId });
    return { slug: tenant.slug, configured: true, enabled: false,
      next: `npm run duo -- check --slug ${tenant.slug}` };
  });
}

/** Ask Duo whether this integration actually works. */
async function check({ slug }) {
  return withOwner(async (db) => {
    const tenant = await tenantBySlug(db, slug);
    const { rows } = await db.query(
      'SELECT api_host, client_id, client_secret_ct FROM tenant_duo WHERE tenant_id = $1',
      [tenant.id]);
    if (!rows[0]) throw new Error(`${slug} has no Duo configuration; run "set" first`);

    const client = mfa.clientFor(tenant.id, rows[0]);
    await client.healthCheck();
    await db.query('UPDATE tenant_duo SET verified_at = now() WHERE tenant_id = $1', [tenant.id]);
    await record(db, tenant.id, 'duo.verified', { apiHost: rows[0].api_host });
    return { slug: tenant.slug, healthCheck: 'ok', verifiedAt: new Date().toISOString() };
  });
}

async function enable({ slug }) {
  return withOwner(async (db) => {
    const tenant = await tenantBySlug(db, slug);
    const { rows } = await db.query(
      'SELECT verified_at FROM tenant_duo WHERE tenant_id = $1', [tenant.id]);
    if (!rows[0]) throw new Error(`${slug} has no Duo configuration; run "set" first`);
    if (!rows[0].verified_at) {
      // Enabling puts a second factor in front of every user at this firm. A
      // configuration nobody has proven works would put a broken one there.
      throw new Error(
        `${slug}'s Duo configuration has never passed a health check. `
        + `Run: npm run duo -- check --slug ${slug}`);
    }
    await db.query(
      'UPDATE tenant_duo SET enabled = true, updated_at = now() WHERE tenant_id = $1',
      [tenant.id]);
    await record(db, tenant.id, 'duo.enabled', {});
    return { slug: tenant.slug, enabled: true };
  });
}

async function disable({ slug }) {
  return withOwner(async (db) => {
    const tenant = await tenantBySlug(db, slug);
    await db.query(
      'UPDATE tenant_duo SET enabled = false, updated_at = now() WHERE tenant_id = $1',
      [tenant.id]);
    // Removing a second factor from a firm's logins is exactly the action an
    // attacker with operator access would take first, so it is audited as
    // loudly as adding one.
    await record(db, tenant.id, 'duo.disabled', {});
    return { slug: tenant.slug, enabled: false };
  });
}

async function failmode({ slug, mode }) {
  if (mode !== 'closed' && mode !== 'open') {
    throw new Error('--mode must be "closed" or "open"');
  }
  return withOwner(async (db) => {
    const tenant = await tenantBySlug(db, slug);
    await db.query(
      'UPDATE tenant_duo SET fail_mode = $2, updated_at = now() WHERE tenant_id = $1',
      [tenant.id, mode]);
    await record(db, tenant.id, 'duo.failmode_changed', { mode });
    return {
      slug: tenant.slug,
      failMode: mode,
      note: mode === 'open'
        ? 'Users will be admitted WITHOUT a second factor when Duo is unreachable. '
          + 'Every such login is audited as auth.mfa_failopen and raises an alarm.'
        : 'Users will not be admitted when Duo is unreachable.',
    };
  });
}

const COMMANDS = { status, set, check, enable, disable, failmode };

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.error('commands: status | set | check | enable | disable | failmode');
    process.exit(1);
  }
  fn(parseArgs(rest))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { status, set, check, enable, disable, failmode };
