'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

/**
 * Migration runner.
 *
 * Runs as the OWNER of the tables, which is deliberately not the role the
 * application uses: an owner bypasses its own row level security unless the
 * table is FORCEd, and the app must never hold that privilege. Two roles, two
 * jobs — see migrations/001_tenancy.sql.
 *
 * Each file runs once, inside one transaction, recorded in `schema_migrations`.
 * A partially applied migration is the thing this prevents: on failure the
 * whole file rolls back and the version is not recorded, so a re-run starts it
 * cleanly instead of resuming half way.
 */
async function migrate(connectionString, { log = console.log } = {}) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    );

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
    return files.filter((f) => !done.has(f));
  } finally {
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) { console.error('set DATABASE_MIGRATION_URL'); process.exit(1); }
  migrate(url).then((applied) => {
    console.log(applied.length ? `applied ${applied.length}` : 'up to date');
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
