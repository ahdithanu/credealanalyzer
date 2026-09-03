'use strict';

const { Pool } = require('pg');
const config = require('../config');

/**
 * The database handle, and the only sanctioned way to touch tenant data.
 *
 * Connections are POOLED, which is what makes the tenant context dangerous if
 * it is set carelessly: `SET app.current_tenant = ...` without LOCAL persists on
 * the physical connection, so the next request to borrow it inherits the last
 * request's tenant. That is a cross-tenant read with no attacker involved — two
 * ordinary users and a busy afternoon. Everything below exists to make that
 * impossible to write by accident.
 */
const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: config.db.max,
});

// A runaway query holds a pooled connection and, under load, starves every
// other request. Bounded per session rather than globally so migrations (which
// use their own connection) are unaffected.
pool.on('connect', (client) => {
  client.query(`SET statement_timeout = ${config.db.statementTimeoutMs}`).catch(() => {});
});

pool.on('error', (err) => {
  // An idle client erroring out is normal (a failover, a killed backend). It
  // must not take the process down, but it must not be silent either.
  console.error(JSON.stringify({ level: 'error', msg: 'idle pg client error', err: err.message }));
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction with the tenant context established.
 *
 * `set_config(..., true)` is the LOCAL form: the setting is scoped to this
 * transaction and is gone when it commits or rolls back, so it cannot outlive
 * the request on a pooled connection. The tenant is passed as a BOUND
 * PARAMETER, never interpolated — `set_config` takes a value, so there is no
 * string concatenation for an injected tenant id to hide in.
 *
 * The uuid shape is checked here as well even though Postgres would reject a
 * bad one, because the error we want is "this code passed something that is not
 * a tenant id", raised at the call site, not a cast failure three frames down.
 *
 * @param {string} tenantId  Resolved from the SESSION. Never from a request
 *   body, query string, path parameter or header — see auth/session.js.
 * @param {string|null} userId  For audit attribution.
 */
async function withTenant(tenantId, userId, fn) {
  if (!UUID.test(String(tenantId || ''))) {
    throw new Error('withTenant: tenantId must be a uuid');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user', userId || '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Rollback failure must not mask the original error, which is the one that
    // explains what happened.
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The platform pool: statements that are legitimately NOT tenant-scoped, such
 * as resolving a tenant by the broker's organization id at login. These happen
 * BEFORE a tenant is known, so they cannot be inside withTenant.
 *
 * Named to be conspicuous in review. Anything reachable from a request path
 * that reads DEAL data through this is a bug, and grepping the name is how you
 * find it. Note it connects as app_user, which since migration 002 cannot read
 * the sessions table at all — so this handle cannot be used to enumerate or
 * mint a session even by mistake.
 */
function unscoped() {
  return pool;
}

/**
 * The AUTHENTICATION pool, connected as `auth_user`.
 *
 * A different role with different privileges, not a convenience alias: it can
 * read and write `sessions` and read the tenant registry, and it cannot see a
 * single deal. app_user is its mirror image. The split means a flaw in the
 * tenant-data path cannot forge a session, and a flaw in the authentication
 * path cannot read a pipeline. See migrations/002_auth_role.sql.
 */
const authPool = new Pool({
  connectionString: config.db.authConnectionString,
  ssl: config.db.ssl,
  max: Math.max(2, Math.floor(config.db.max / 2)),
});
authPool.on('connect', (client) => {
  client.query(`SET statement_timeout = ${config.db.statementTimeoutMs}`).catch(() => {});
});
authPool.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'idle auth pg client error', err: err.message }));
});

module.exports = { withTenant, unscoped, pool, authPool };
