'use strict';

const { Client } = require('pg');

/**
 * Test fixtures against a real Postgres.
 *
 * RUN SERIALLY (`--test-concurrency=1`, set in package.json). Each file gets
 * its own database, but Postgres ROLES are cluster-wide, so the CREATE/ALTER
 * ROLE statements in the migrations collide across parallel files with
 * "tuple concurrently updated". The alternative — bootstrapping roles once,
 * outside the migrations — would mean a fresh environment could apply the
 * schema and still not work, which is a worse trade than a slower test run.
 */
const { migrate } = require('../src/db/migrate');

/**
 * Connection details, environment-driven so the same suite runs in two places:
 *
 *   locally  a unix socket in /tmp, superuser `postgres`, no password
 *   in CI    a TCP service container, superuser `cre_owner`, a password
 *
 * Hard-coding the socket form meant the suite could not run in CI at all, which
 * is how a repository ends up with 1,162 tests and no merge gate.
 */
const HOST = process.env.PGHOST_DIR || '/tmp';
const PORT = process.env.PGPORT || 5433;
const SUPERUSER = process.env.TEST_PG_USER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || '';

/** A socket directory starts with '/'; anything else is a TCP host. */
const isSocket = String(HOST).startsWith('/');
const auth = (user) => (PASSWORD ? `${user}:${encodeURIComponent(PASSWORD)}` : user);
const url = (user, db) => (isSocket
  ? `postgres://${auth(user)}@localhost:${PORT}/${db}?host=${HOST}`
  : `postgres://${auth(user)}@${HOST}:${PORT}/${db}`);

const ADMIN = url(SUPERUSER, 'postgres');

/**
 * A throwaway database per test file, so tests cannot see each other's rows.
 *
 * `applyMigrations: false` hands back a bootstrapped but EMPTY database, for
 * the tests that need to watch the migrations themselves succeed or refuse.
 */
async function freshDatabase(name, { applyMigrations = true } = {}) {
  const db = `cre_test_${name}_${process.pid}`;
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();

  const ownerUrl = url(SUPERUSER, db);

  /**
   * MIGRATIONS RUN AS A NON-SUPERUSER, and this is load-bearing rather than
   * tidy-minded.
   *
   * They used to run as the fixture's superuser, which meant every table and
   * function in the test schema was owned by a role that BYPASSES ROW LEVEL
   * SECURITY unconditionally — FORCE ROW LEVEL SECURITY included, since a
   * superuser is exempt from that too. The tests then exercised the one access
   * path no deployed caller ever takes.
   *
   * It hid a real bug for as long as the audit chain has existed:
   * audit_log_verify() read audit_log under the tenant_isolation policy, so
   * from the application's own pool it matched no rows, never entered its loop,
   * and returned its "intact" signal on a log it had not looked at. Over the
   * superuser connection the tests used, it saw everything and passed.
   *
   * In AWS the owner is `cre_owner` — an ordinary role that Postgres holds to
   * its own policies. Mirroring that here is what makes the owner-facing policy
   * in migration 008 mean something in a test rather than being decoration that
   * a superuser renders unnecessary.
   *
   * The fixtures' own setup and teardown stay on the superuser connection. They
   * are standing in for an operator with the keys to the box — simulating
   * tampering, inspecting rows across tenants — and that is exactly the actor
   * they should be.
   */
  const bootstrap = new Client({ connectionString: ownerUrl });
  await bootstrap.connect();
  // CREATEROLE because the migrations create app_user and auth_user themselves;
  // a schema that cannot be applied to an empty cluster is not a schema.
  await bootstrap.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cre_owner') THEN
      CREATE ROLE cre_owner LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  // Stated unconditionally: roles are cluster-wide, so an existing cre_owner
  // from an earlier run keeps whatever attributes it had and the IF NOT EXISTS
  // above quietly skips it. The same trap that left app_user NOLOGIN once.
  await bootstrap.query('ALTER ROLE cre_owner LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS');
  // pgcrypto is an operator-installed extension, not an application one: on RDS
  // it takes rds_superuser, and a role that could install arbitrary extensions
  // is a role that could install one containing a C function. Creating it here
  // mirrors that division rather than handing the migration role the privilege.
  await bootstrap.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  // The application roles are cluster-wide and outlive any one test database,
  // so on the second run they already exist and were created by the superuser.
  // Since Postgres 16 a CREATEROLE role may only alter roles it holds ADMIN
  // OPTION on, so without this the migrations fail with "permission denied to
  // alter role" — on a cluster where the very same migration succeeded once.
  await bootstrap.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
      CREATE ROLE app_user NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_user') THEN
      CREATE ROLE auth_user NOLOGIN;
    END IF;
  END $$`);
  await bootstrap.query('GRANT app_user, auth_user TO cre_owner WITH ADMIN OPTION');
  await bootstrap.query(`GRANT ALL ON SCHEMA public TO cre_owner`);
  await bootstrap.query(`ALTER SCHEMA public OWNER TO cre_owner`);
  await bootstrap.end();

  const migrationUrl = url('cre_owner', db);
  if (applyMigrations) await migrate(migrationUrl, { log: () => {} });

  // The application role. Note it is NOT the owner: `postgres` created the
  // tables, `app_user` only uses them. That difference is the reason RLS binds
  // at all, and the tests below prove it rather than trusting it.
  // app_user and auth_user are created by the migrations with no password. In
  // CI, Postgres is configured to trust local connections for them; in AWS both
  // are granted rds_iam and hold no password at all.
  const appUrl = url('app_user', db);
  const authUrl = url('auth_user', db);
  return { db, ownerUrl, migrationUrl, appUrl, authUrl, drop: async () => {
    const a = new Client({ connectionString: ADMIN });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await a.end();
  } };
}

/** Two tenants with a user and a deal each — the fixture isolation is about. */
async function seedTwoTenants(ownerUrl) {
  const c = new Client({ connectionString: ownerUrl });
  await c.connect();
  const mk = async (slug, name, org, domain) => {
    const t = await c.query(
      'INSERT INTO tenants (slug, name, broker_org_id) VALUES ($1,$2,$3) RETURNING id',
      [slug, name, org],
    );
    const tenantId = t.rows[0].id;
    await c.query(
      'INSERT INTO tenant_domains (tenant_id, domain, verified_at) VALUES ($1,$2,now())',
      [tenantId, domain],
    );
    const u = await c.query(
      'INSERT INTO users (tenant_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id',
      [tenantId, `analyst@${domain}`, 'An Analyst', 'analyst'],
    );
    const d = await c.query(
      'INSERT INTO deals (tenant_id, name, stage, payload, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [tenantId, `${name} Tower`, 'Screening', JSON.stringify({ purchasePrice: 1000000 }), u.rows[0].id],
    );
    return { tenantId, userId: u.rows[0].id, dealId: d.rows[0].id, domain };
  };
  const a = await mk('firm-x', 'Firm X', 'org_x', 'firmx.com');
  const b = await mk('firm-y', 'Firm Y', 'org_y', 'firmy.com');
  await c.end();
  return { a, b };
}

module.exports = { freshDatabase, seedTwoTenants, ADMIN };
