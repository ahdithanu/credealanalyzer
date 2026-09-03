'use strict';

const { Client } = require('pg');

/**
 * Tenant onboarding.
 *
 * DELIBERATELY NOT AN HTTP ROUTE. Provisioning a tenant means writing the
 * broker organization id that the login path trusts to decide which firm a user
 * belongs to, and marking an email domain as verified. An internet-reachable
 * endpoint that can do either is an endpoint that can, if it is ever broken,
 * admit an attacker into a client firm's tenant — by pointing that firm's
 * organization id at a tenant they control, or by verifying a domain they own.
 *
 * There is no business reason for it to be reachable. Onboarding happens a
 * handful of times a year, by a person, and it is exactly the sort of operation
 * that should require the platform credential and leave a record. So it runs as
 * a CLI against the OWNER connection, which the API tasks do not hold: the
 * grants in migration 001 give app_user and auth_user only SELECT on `tenants`
 * and `tenant_domains`, and isolation.test.js asserts that a request path
 * cannot write them.
 *
 * Usage (DATABASE_MIGRATION_URL is the owner credential from Secrets Manager):
 *   node src/admin/tenants.js create --slug firm-x --name "Firm X" --org org_123
 *   node src/admin/tenants.js verify-domain --slug firm-x --domain firmx.com
 *   node src/admin/tenants.js list
 *   node src/admin/tenants.js suspend --slug firm-x
 *   node src/admin/tenants.js revoke-sessions --slug firm-x
 */

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Deliberately strict, and it rejects things a permissive regex would take. No
// leading dot, no consecutive dots, at least one label plus a 2+ char TLD. The
// domain list is a security boundary — see the domain check in auth/login.js —
// so a malformed entry that never matches is safer than a clever one that
// matches too much.
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,}$/;

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

async function create({ slug, name, org }) {
  if (!SLUG.test(String(slug || ''))) {
    throw new Error('--slug must be lowercase letters, digits and hyphens (2-63 chars)');
  }
  if (!name || String(name).length > 200) throw new Error('--name is required (max 200 chars)');
  if (!org || String(org).length > 200) throw new Error('--org (broker organization id) is required');

  return withOwner(async (db) => {
    // The organization id is UNIQUE in the schema, so this cannot silently
    // repoint an existing firm's identity provider at a new tenant — the most
    // dangerous mistake available here. It fails instead.
    const { rows } = await db.query(
      `INSERT INTO tenants (slug, name, broker_org_id) VALUES ($1,$2,$3)
       RETURNING id, slug, name, broker_org_id, status`,
      [slug, name, org],
    );
    return rows[0];
  });
}

async function verifyDomain({ slug, domain }) {
  const d = String(domain || '').trim().toLowerCase();
  if (!DOMAIN.test(d)) throw new Error(`--domain is not a valid domain: ${domain}`);

  return withOwner(async (db) => {
    const t = await db.query('SELECT id FROM tenants WHERE slug = $1', [slug]);
    if (!t.rows[0]) throw new Error(`no tenant with slug ${slug}`);

    // A domain may be verified for only ONE tenant. Two firms both claiming
    // acme.com would make the login path's domain check ambiguous, and the
    // tenant a user landed in would depend on which row was read first.
    const clash = await db.query(
      `SELECT t.slug FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
        WHERE lower(d.domain) = $1 AND d.tenant_id <> $2 AND d.verified_at IS NOT NULL`,
      [d, t.rows[0].id],
    );
    if (clash.rows[0]) {
      throw new Error(`${d} is already verified for tenant ${clash.rows[0].slug}`);
    }

    // verified_at is set HERE, by an operator, and is not something the
    // application can set. Proving control of a domain (a DNS TXT record, or
    // the broker's own domain verification) happens outside this tool; this
    // records the conclusion.
    const { rows } = await db.query(
      `INSERT INTO tenant_domains (tenant_id, domain, verified_at)
            VALUES ($1,$2,now())
       ON CONFLICT (tenant_id, domain) DO UPDATE SET verified_at = now()
       RETURNING tenant_id, domain, verified_at`,
      [t.rows[0].id, d],
    );
    return rows[0];
  });
}

async function list() {
  return withOwner(async (db) => {
    const { rows } = await db.query(`
      SELECT t.slug, t.name, t.status, t.broker_org_id,
             (SELECT count(*) FROM users u WHERE u.tenant_id = t.id)  AS users,
             (SELECT count(*) FROM deals dl WHERE dl.tenant_id = t.id
                AND dl.deleted_at IS NULL)                            AS deals,
             (SELECT array_agg(d.domain ORDER BY d.domain) FROM tenant_domains d
                WHERE d.tenant_id = t.id AND d.verified_at IS NOT NULL) AS domains
        FROM tenants t ORDER BY t.created_at`);
    return rows;
  });
}

async function setStatus({ slug, status }) {
  return withOwner(async (db) => {
    const { rows } = await db.query(
      'UPDATE tenants SET status = $2 WHERE slug = $1 RETURNING slug, status',
      [slug, status],
    );
    if (!rows[0]) throw new Error(`no tenant with slug ${slug}`);
    return rows[0];
  });
}

/**
 * Revoke every live session for a tenant.
 *
 * Suspending a tenant already blocks new requests — session.resolve() checks
 * the tenant status on every call — but revoking is the harder guarantee, and
 * for an offboarding or a suspected compromise the two should be done together.
 */
async function revokeSessions({ slug }) {
  return withOwner(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE revoked_at IS NULL
          AND tenant_id = (SELECT id FROM tenants WHERE slug = $1)`,
      [slug],
    );
    return { slug, revoked: rowCount };
  });
}

module.exports = { create, verifyDomain, list, setStatus, revokeSessions, __internals: { SLUG, DOMAIN } };

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const run = {
    create: () => create(args),
    'verify-domain': () => verifyDomain(args),
    list: () => list(),
    suspend: () => setStatus({ ...args, status: 'suspended' }),
    activate: () => setStatus({ ...args, status: 'active' }),
    'revoke-sessions': () => revokeSessions(args),
  }[command];

  if (!run) {
    console.error('commands: create | verify-domain | list | suspend | activate | revoke-sessions');
    process.exit(2);
  }
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
