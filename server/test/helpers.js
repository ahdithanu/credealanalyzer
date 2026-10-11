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
  // EVERYTHING below runs inside try/finally so the client closes on failure
  // too, and that is not tidiness. An open pg socket keeps the event loop
  // alive, so a bootstrap that threw left `node --test` with nothing to do and
  // no reason to exit: the file ran until GitHub's six-hour job ceiling and was
  // reported as CANCELLED rather than failed. Six hours of silence for an
  // error that took sixty milliseconds to happen.
  try {
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
    // Wrapped, because this statement has TWO failure modes and both used to
    // present as something else. Postgres refuses it outright when the
    // connection is itself cre_owner — "permission denied to alter role",
    // which says nothing about why — and on some clusters it can succeed
    // without the attributes ending up as asked. The check below covers both,
    // so either way the message names the cause and the fix.
    let alterRefused = null;
    try {
      await bootstrap.query('ALTER ROLE cre_owner LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS');
    } catch (err) {
      alterRefused = err.message;
    }

    /**
     * SET, THEN VERIFY — the same discipline migration 001 applies to app_user,
     * and for a reason this suite learned the hard way.
     *
     * The ALTER above is the only thing making cre_owner an ordinary role, and
     * an ordinary role is the only reason FORCE ROW LEVEL SECURITY binds to the
     * table owner. If it silently does not take, every isolation test in this
     * directory still passes — over a connection that bypasses the policies
     * entirely. That is the exact failure the comment above freshDatabase
     * describes, and leaving the ALTER unverified left the door open to it.
     *
     * It does not take when the fixture's own superuser IS cre_owner: the role
     * cannot be demoted out from under the connection using it. That was CI's
     * configuration — POSTGRES_USER and TEST_PG_USER both cre_owner — so the
     * server suite never once ran with row level security actually binding.
     */
    const { rows: ownerRows } = await bootstrap.query(
      `SELECT rolsuper, rolbypassrls, rolcanlogin
         FROM pg_roles WHERE rolname = 'cre_owner'`,
    );
    const owner = ownerRows[0] || {};
    if (alterRefused || owner.rolsuper || owner.rolbypassrls || !owner.rolcanlogin) {
      throw new Error(
        (alterRefused ? `Postgres refused to set cre_owner's attributes (${alterRefused}). ` : '')
      + 'cre_owner must be LOGIN, NOSUPERUSER and NOBYPASSRLS, and it is not '
        + `(super=${owner.rolsuper}, bypassrls=${owner.rolbypassrls}, `
        + `login=${owner.rolcanlogin}). Row level security does not bind to a `
        + 'superuser or a BYPASSRLS role — FORCE included — so the isolation '
        + 'suite would pass over the one connection no deployed caller uses. '
        + `This happens when the fixture connects AS cre_owner, since a role `
        + 'cannot be demoted out from under its own session: set TEST_PG_USER '
        + '(and the server\'s POSTGRES_USER) to a DIFFERENT superuser, such as '
        + 'postgres, and let the fixture create cre_owner as an ordinary role.',
      );
    }
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
    // Created WITH the attributes migration 001 insists on, by the superuser,
    // because only a superuser can set NOSUPERUSER. Created NOLOGIN instead —
    // as this did — the migration's own ALTER is refused, its EXCEPTION handler
    // swallows the refusal, and its verification then fails the whole run with
    // "app_user must be LOGIN NOSUPERUSER ... and this migration could not
    // correct it". That is the migration behaving exactly as designed; the
    // fixture was the thing not holding up its end. It stands in for an
    // operator here, and an operator is who that error tells you to go and be.
    await bootstrap.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_user') THEN
        CREATE ROLE auth_user;
      END IF;
    END $$`);
    // Unconditionally, for the reason stated above cre_owner: roles are
    // cluster-wide, so an existing one keeps whatever attributes it had.
    for (const role of ['app_user', 'auth_user']) {
      await bootstrap.query(
        `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
    }

    /**
     * And a password, when the fixture is using one.
     *
     * url() above attaches PASSWORD to every role it builds a URL for, so on a
     * server that actually authenticates — CI reaches Postgres over TCP, where
     * the official image uses scram-sha-256 — a passwordless app_user cannot
     * connect at all. The comment here used to claim CI trusts these roles
     * locally; it does not, and nothing checked.
     *
     * Skipped when PASSWORD is empty, which is the local socket+trust setup.
     */
    if (PASSWORD) {
      // ALTER ROLE is a utility statement and takes no bind parameters, so the
      // literal is built with doubled quotes rather than passed as $1.
      const quoted = `'${PASSWORD.replace(/'/g, "''")}'`;
      for (const role of ['cre_owner', 'app_user', 'auth_user']) {
        await bootstrap.query(`ALTER ROLE ${role} PASSWORD ${quoted}`);
      }
    }
    await bootstrap.query('GRANT app_user, auth_user TO cre_owner WITH ADMIN OPTION');
    await bootstrap.query(`GRANT ALL ON SCHEMA public TO cre_owner`);
      await bootstrap.query(`ALTER SCHEMA public OWNER TO cre_owner`);
  } finally {
    await bootstrap.end();
  }

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
