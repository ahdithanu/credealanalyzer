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

const HOST = process.env.PGHOST_DIR || '/tmp';
const PORT = process.env.PGPORT || 5433;
const ADMIN = `postgres://postgres@localhost:${PORT}/postgres?host=${HOST}`;

/** A throwaway database per test file, so tests cannot see each other's rows. */
async function freshDatabase(name) {
  const db = `cre_test_${name}_${process.pid}`;
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();

  const ownerUrl = `postgres://postgres@localhost:${PORT}/${db}?host=${HOST}`;
  await migrate(ownerUrl, { log: () => {} });

  // The application role. Note it is NOT the owner: `postgres` created the
  // tables, `app_user` only uses them. That difference is the reason RLS binds
  // at all, and the tests below prove it rather than trusting it.
  const appUrl = `postgres://app_user@localhost:${PORT}/${db}?host=${HOST}`;
  const authUrl = `postgres://auth_user@localhost:${PORT}/${db}?host=${HOST}`;
  return { db, ownerUrl, appUrl, authUrl, drop: async () => {
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
