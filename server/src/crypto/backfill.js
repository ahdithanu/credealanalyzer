'use strict';

const { Client } = require('pg');
const { sealPayload, __clearKeyCache } = require('./keyring');
const { recordAdmin } = require('../admin/tenants');

/**
 * Convert pre-migration-005 plaintext payloads to ciphertext. Once.
 *
 * WHY THIS EXISTS RATHER THAN A `WHEN` IN THE MIGRATION. Encryption needs a key
 * provider, which needs KMS, which needs the application's IAM role and the
 * network. A migration runs under the owner credential in a deploy step that
 * has neither, and a SQL file cannot call KMS at all. So the schema change
 * (which is instant) is separated from the data change (which is not), and the
 * read path in keyring.js accepts both shapes in the meantime. A deploy is
 * therefore safe whether or not this has been run.
 *
 * DELIBERATELY NOT AN HTTP ROUTE, for the reasons at the top of
 * admin/tenants.js. It reads every tenant's plaintext underwriting models.
 *
 * DRY RUN IS THE DEFAULT. It reports what it would convert and writes nothing.
 * Pass --apply to do it.
 *
 * Usage (DATABASE_MIGRATION_URL is the owner credential):
 *   node src/crypto/backfill.js                 # report only
 *   node src/crypto/backfill.js --apply
 *   node src/crypto/backfill.js --apply --tenant firm-x
 */

// Sealed one row at a time but committed in batches: a single transaction over
// a large table holds locks for the length of the whole conversion and blocks
// the vacuum of a table the application is actively writing.
const BATCH = 200;

async function withOwner(fn) {
  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('set DATABASE_MIGRATION_URL to the owner credential');
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/**
 * @param {object} opts
 * @param {boolean} opts.apply  false (the default) reports and writes nothing.
 * @param {string}  [opts.tenant] a slug, to convert one firm at a time.
 */
async function backfill({ apply = false, tenant = null, log = console.log } = {}) {
  return withOwner(async (db) => {
    const tenants = await db.query(
      `SELECT t.id, t.slug,
              (SELECT count(*) FROM deals d
                WHERE d.tenant_id = t.id AND d.payload IS NOT NULL)::int AS plaintext
         FROM tenants t
        WHERE ($1::text IS NULL OR t.slug = $1)
        ORDER BY t.slug`,
      [tenant],
    );
    if (tenant && !tenants.rows.length) throw new Error(`no tenant with slug ${tenant}`);

    const report = [];
    for (const t of tenants.rows) {
      if (t.plaintext === 0) { report.push({ slug: t.slug, plaintext: 0, converted: 0 }); continue; }
      if (!apply) {
        report.push({ slug: t.slug, plaintext: t.plaintext, converted: 0, dryRun: true });
        continue;
      }

      let converted = 0;
      for (;;) {
        await db.query('BEGIN');
        try {
          // The tenant context is set even though the owner credential
          // generally bypasses row level security, so that this tool also works
          // against an owner that does NOT bypass it — and the explicit
          // tenant_id predicates below are there for the same reason. This is
          // not a request path; it does not get to rely on the policy.
          await db.query('SELECT set_config($1,$2,true)', ['app.current_tenant', t.id]);

          const batch = await db.query(
            `SELECT id, payload FROM deals
              WHERE tenant_id = $1 AND payload IS NOT NULL
              ORDER BY id LIMIT $2
                FOR UPDATE`,
            [t.id, BATCH],
          );
          if (!batch.rows.length) { await db.query('COMMIT'); break; }

          for (const row of batch.rows) {
            const ct = await sealPayload(db, t.id, row.payload);
            // Both columns in ONE statement. Written as two, a crash between
            // them leaves a row with neither shape set, which the check
            // constraint would reject — or, in the other order, a row holding
            // the plaintext and the ciphertext at once, which makes the
            // encryption claim false for a row nobody can find.
            await db.query(
              'UPDATE deals SET payload = NULL, payload_ct = $2 WHERE id = $1 AND tenant_id = $3',
              [row.id, ct, t.id],
            );
            converted += 1;
          }
          await db.query('COMMIT');
        } catch (err) {
          await db.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }

      await recordAdmin(db, {
        tenantId: t.id,
        action: 'tenant.payloads_encrypted',
        subjectType: 'tenant',
        subjectId: t.slug,
        detail: { converted },
      });
      report.push({ slug: t.slug, plaintext: t.plaintext, converted });
      // The next tenant must not reuse this one's unwrapped key.
      __clearKeyCache();
    }

    const total = report.reduce((n, r) => n + r.converted, 0);
    log(apply
      ? `converted ${total} payload${total === 1 ? '' : 's'}`
      : `DRY RUN — ${report.reduce((n, r) => n + r.plaintext, 0)} plaintext payload(s) would be converted; pass --apply`);
    return { apply, tenants: report };
  });
}

module.exports = { backfill };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const tenantAt = argv.indexOf('--tenant');
  backfill({
    apply: argv.includes('--apply'),
    tenant: tenantAt >= 0 ? argv[tenantAt + 1] : null,
  })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
