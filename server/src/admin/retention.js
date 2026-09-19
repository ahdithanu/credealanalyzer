'use strict';

const { Client } = require('pg');
const { recordAdmin } = require('./tenants');
const { keyProvider } = require('../crypto/keyProvider');
const mfa = require('../auth/mfa');

/**
 * Retention, purging and tenant offboarding.
 *
 * ─── THE CONFLICT, AND WHICH SIDE THIS TAKES ────────────────────────────────
 *
 * Migration 003 makes `audit_log` append-only and hash-chained: each row commits
 * to the one before it, so deleting or editing any historical entry is
 * detectable from the next row onward. That is the property the audit log is
 * for. A right-to-erasure request asks for the opposite — remove this firm's
 * data — and the two cannot both be satisfied by deleting rows. Honouring an
 * erasure by deleting audit entries breaks the chain, and a broken chain is
 * indistinguishable from a cover-up: after the first erasure, nobody can tell
 * a lawful deletion from an attacker editing their own tracks.
 *
 * Two defensible answers:
 *
 *   (a) CRYPTO-SHREDDING. Tenant content is encrypted under a per-tenant data
 *       key (migration 005). Erasure destroys the key. The audit chain is not
 *       encrypted, so it still verifies end to end; the content is unrecoverable
 *       by anyone, including us.
 *
 *   (b) A DOCUMENTED LEGITIMATE-INTEREST BASIS for retaining audit entries, with
 *       personal data minimised in them from the start.
 *
 * THIS IMPLEMENTS (a). WHY (b) WAS REJECTED AS THE ANSWER:
 *
 * (b) is an argument about the AUDIT LOG, and the audit log is not where the
 * problem is. The confidential material is `deals.payload` — the purchase price,
 * the rent roll, the debt terms, the exit assumption. (b) offers that material
 * no erasure mechanism at all: a DELETE removes it from the live table and from
 * nowhere else. It remains in last night's snapshot, in the WAL archive, in the
 * read replica and in whatever a restore drill copied to a laptop. An erasure
 * answer that reaches only the table the operator happens to be connected to is
 * not an erasure answer; it is a statement about one table.
 *
 * Destroying the key CAN reach every one of those copies at once — but only if
 * the key material lives somewhere the snapshot does not.
 *
 * THAT WAS NOT TRUE WHEN THIS WAS FIRST WRITTEN, and the paragraph here claimed
 * it was. `tenant_keys.wrapped_key` sits in the same Postgres database as
 * `deals.payload_ct`, so every snapshot, WAL segment and replica contains the
 * wrapped key beside the ciphertext it opens. Nulling it in the live row erases
 * nothing a restore cannot undo. A verifier reproduced it end to end: offboard,
 * then restore last night's dump, unwrap with the still-live master key, and
 * read the deal back in full. The claim was asserted to the customer inside the
 * audit entry as a legal basis, which is the worst place for a false one.
 *
 * So the guarantee is now CONDITIONAL and the code says which case it is in:
 *
 *   KMS with per-tenant customer master keys — ScheduleKeyDeletion destroys
 *   material AWS holds, no copy of the database can be opened again, and the
 *   strong claim is earned. Note the 7-30 day AWS waiting period: the erasure
 *   is committed on the day it is requested and complete on a later date, and
 *   both go in the record.
 *
 *   Shared CMK, or the local provider — the wrapped key is recoverable from a
 *   snapshot, so the honest claim is "erased from live systems; backups expire
 *   on their own schedule". That is a weaker promise and a legitimate one, and
 *   it is what a DPA should say unless per-tenant keys are switched on.
 *
 * WHAT (a) DOES NOT DO, STATED RATHER THAN GLOSSED:
 *
 *   - It does not erase the audit entries. They survive an offboarding here too,
 *     and the ground for keeping them is exactly the minimisation (b) describes:
 *     the `detail` column records an email DOMAIN rather than a full address,
 *     deliberately, and has since 003. So this is not a rejection of (b)'s
 *     reasoning — it is a rejection of (b) as the SOLE mechanism. Both are in
 *     use, each for what it can actually do.
 *   - It does not cover what is NOT encrypted: a deal's `name` and `stage`, user
 *     emails, firm defaults. Offboarding hard-deletes those rows, so the live
 *     database is clean, but a backup taken beforehand still holds them and no
 *     key destruction changes that. Their erasure is bounded by the backup
 *     retention window and nothing shorter. If that ever becomes insufficient,
 *     the fix is to widen the envelope to those columns — not to claim the
 *     shredding already covers them.
 *
 * ─── OPERATIONALLY ───────────────────────────────────────────────────────────
 *
 * DELIBERATELY NOT AN HTTP ROUTE, for the reasons at the top of admin/tenants.js
 * and with more force: these commands destroy data irreversibly. It runs as a
 * CLI against the OWNER connection, which the API tasks do not hold.
 *
 * That owner credential is assumed to BYPASS row level security, the same
 * assumption tenants.js already makes — recordAdmin() writes audit rows for
 * several tenants with no `app.current_tenant` set, which the policy from 001
 * would otherwise reject. It is stated here rather than discovered later,
 * because an owner role provisioned without BYPASSRLS would make these commands
 * fail in ways that read like missing data rather than missing privilege.
 *
 * DRY RUN IS THE DEFAULT, on every destructive command. A deletion tool whose
 * default is to delete is a deletion tool that will one day be run with the
 * wrong argument — a missing flag, a shell history entry, a half-edited runbook
 * line. Here the missing argument produces a report.
 *
 * Usage (DATABASE_MIGRATION_URL is the owner credential from Secrets Manager):
 *   node src/admin/retention.js show
 *   node src/admin/retention.js set-retention --slug firm-x --days 30
 *   node src/admin/retention.js set-retention --slug firm-x --days none
 *   node src/admin/retention.js purge                      # report only
 *   node src/admin/retention.js purge --apply
 *   node src/admin/retention.js purge --apply --tenant firm-x
 *   node src/admin/retention.js offboard --slug firm-x     # report only
 *   node src/admin/retention.js offboard --slug firm-x --apply --reason TICKET-123
 */

/**
 * The platform retention window for soft-deleted deals, in days.
 *
 * A POLICY, not a measurement, which is why it has a value at all: every tenant
 * needs an answer to "how long is a deleted deal recoverable" and silence is not
 * one. Ninety days is long enough to survive a quarter-end mistake and a holiday,
 * short enough to be a real commitment. A tenant that negotiated something else
 * carries it in `tenants.retention_days`, and every report below names which of
 * the two it used.
 */
const PLATFORM_DEFAULT_RETENTION_DAYS = Number(process.env.RETENTION_DEFAULT_DAYS || 90);

if (!Number.isInteger(PLATFORM_DEFAULT_RETENTION_DAYS) || PLATFORM_DEFAULT_RETENTION_DAYS < 1) {
  throw new Error('RETENTION_DEFAULT_DAYS must be a whole number of days, at least 1');
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

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

/**
 * Resolve the window that will actually be applied, and say where it came from.
 *
 * `retention_days IS NULL` means "no tenant-specific window", which is NOT zero
 * and NOT "never". Returning the source alongside the number is what stops a
 * report reading as though a firm negotiated ninety days when in fact nobody set
 * anything.
 */
function effectiveRetention(tenantRow) {
  return tenantRow.retention_days === null || tenantRow.retention_days === undefined
    ? { days: PLATFORM_DEFAULT_RETENTION_DAYS, source: 'platform-default' }
    : { days: Number(tenantRow.retention_days), source: 'tenant' };
}

/**
 * Write the audit entry INSIDE the caller's open transaction, and prove it
 * landed.
 *
 * recordAdmin is best-effort by design — it swallows a failure so that an audit
 * problem cannot roll back an operation an administrator believes succeeded.
 * That is right for tenants.js, where the operations are additive. It is exactly
 * wrong here, where the operation is a deletion: a purge that is not audited is
 * indistinguishable from a breach, and there is no version of "the data is gone
 * and we have no record of removing it" that is acceptable.
 *
 * So the entry goes in the same transaction as the deletion, and this probes the
 * connection afterwards. If the INSERT failed, the transaction is in its aborted
 * state and the probe throws — the caller's COMMIT would otherwise have silently
 * become a ROLLBACK and reported success. Destruction and its record therefore
 * commit together or not at all, which is stronger than writing the record first.
 */
async function auditOrFail(db, entry) {
  await recordAdmin(db, entry);
  try {
    await db.query('SELECT 1');
  } catch (err) {
    throw new Error(`refusing to proceed: the audit entry could not be written (${err.message})`);
  }
}

// ─── Reporting ───────────────────────────────────────────────────────────────

/** Every tenant, its effective window, and how much is currently eligible. */
async function show({ tenant = null } = {}) {
  return withOwner(async (db) => {
    const { rows } = await db.query(
      `SELECT t.id, t.slug, t.name, t.status, t.retention_days, t.offboarded_at,
              k.destroyed_at AS key_destroyed_at
         FROM tenants t
         LEFT JOIN tenant_keys k ON k.tenant_id = t.id
        WHERE ($1::text IS NULL OR t.slug = $1)
        ORDER BY t.slug`,
      [tenant],
    );
    const out = [];
    for (const t of rows) {
      const { days, source } = effectiveRetention(t);
      const counts = await db.query(
        `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int     AS "liveDeals",
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS "softDeletedDeals",
                count(*) FILTER (WHERE deleted_at IS NOT NULL
                             AND deleted_at < now() - make_interval(days => $2))::int
                                                                   AS "eligibleForPurge"
           FROM deals WHERE tenant_id = $1`,
        [t.id, days],
      );
      out.push({
        slug: t.slug,
        status: t.status,
        offboardedAt: t.offboarded_at,
        keyDestroyedAt: t.key_destroyed_at || null,
        retentionDays: days,
        retentionSource: source,
        ...counts.rows[0],
      });
    }
    return out;
  });
}

// ─── Retention window ────────────────────────────────────────────────────────

/**
 * @param {number|'none'} days  'none' clears the override so the platform
 *   default applies again. Clearing is NOT the same as setting a large number
 *   and must not be spelled that way.
 */
async function setRetention({ slug, days }) {
  if (!SLUG.test(String(slug || ''))) throw new Error('--slug is required');

  let value;
  if (days === 'none' || days === null) {
    value = null;
  } else {
    value = Number(days);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error('--days must be a whole number of days (at least 1), or "none"');
    }
  }

  return withOwner(async (db) => {
    const { rows } = await db.query(
      `UPDATE tenants SET retention_days = $2 WHERE slug = $1
       RETURNING id, slug, retention_days`,
      [slug, value],
    );
    if (!rows[0]) throw new Error(`no tenant with slug ${slug}`);
    const { days: effective, source } = effectiveRetention(rows[0]);
    // Not a deletion, so the best-effort recordAdmin is the right one here —
    // same reasoning as every command in tenants.js.
    await recordAdmin(db, {
      tenantId: rows[0].id,
      action: 'tenant.retention_set',
      subjectType: 'tenant',
      subjectId: slug,
      detail: { retentionDays: value, effectiveDays: effective, source },
    });
    return { slug, retentionDays: effective, retentionSource: source };
  });
}

// ─── Purge ───────────────────────────────────────────────────────────────────

/**
 * Hard-delete soft-deleted deals past their tenant's window.
 *
 * @param {object} opts
 * @param {boolean} opts.apply   false (the default) reports and deletes nothing.
 * @param {string} [opts.tenant] a slug, to run one firm at a time.
 */
async function purge({ apply = false, tenant = null, log = console.log } = {}) {
  return withOwner(async (db) => {
    const tenants = await db.query(
      `SELECT id, slug, retention_days FROM tenants
        WHERE ($1::text IS NULL OR slug = $1) ORDER BY slug`,
      [tenant],
    );
    if (tenant && !tenants.rows.length) throw new Error(`no tenant with slug ${tenant}`);

    const report = [];
    for (const t of tenants.rows) {
      const { days, source } = effectiveRetention(t);

      if (!apply) {
        const eligible = await db.query(
          `SELECT count(*)::int AS n FROM deals
            WHERE tenant_id = $1
              AND deleted_at IS NOT NULL
              AND deleted_at < now() - make_interval(days => $2)`,
          [t.id, days],
        );
        report.push({
          slug: t.slug,
          retentionDays: days,
          retentionSource: source,
          eligible: eligible.rows[0].n,
          // NULL, not 0. Nothing was purged because nothing was ATTEMPTED, and
          // "purged: 0" beside "eligible: 47" reads as "there was nothing to
          // do" — the one conclusion a dry run must never invite.
          purged: null,
          dryRun: true,
        });
        continue;
      }

      await db.query('BEGIN');
      try {
        // RETURNING first, so the audit entry carries the exact set that went
        // — not a count taken from a different snapshot a moment earlier.
        const gone = await db.query(
          `DELETE FROM deals
            WHERE tenant_id = $1
              AND deleted_at IS NOT NULL
              AND deleted_at < now() - make_interval(days => $2)
        RETURNING id, name, deleted_at`,
          [t.id, days],
        );

        if (gone.rows.length) {
          await auditOrFail(db, {
            tenantId: t.id,
            action: 'deal.purged',
            subjectType: 'tenant',
            subjectId: t.slug,
            detail: {
              retentionDays: days,
              retentionSource: source,
              purged: gone.rows.length,
              // The ids, so a later question of the form "where did deal X go"
              // has an answer. Names are NOT recorded: the entry must not
              // reconstitute the content the purge removed. Capped, because an
              // unbounded array in a jsonb column is its own outage.
              dealIds: gone.rows.slice(0, 500).map((r) => r.id),
              dealIdsTruncated: gone.rows.length > 500,
            },
          });
        }
        await db.query('COMMIT');
        report.push({
          slug: t.slug, retentionDays: days, retentionSource: source,
          eligible: gone.rows.length, purged: gone.rows.length, dryRun: false,
        });
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }

    const total = report.reduce((n, r) => n + (r.purged || 0), 0);
    const eligible = report.reduce((n, r) => n + r.eligible, 0);
    log(apply
      ? `purged ${total} deal${total === 1 ? '' : 's'}`
      : `DRY RUN — ${eligible} deal(s) are past their retention window; pass --apply to purge`);
    /**
     * Spent second-factor challenges.
     *
     * Not tenant-scoped and not governed by a firm's retention window, because
     * a consumed `mfa_pending` row is not deal data — it is authentication
     * exhaust. Nothing reads one after it is claimed, so keeping them is a pure
     * retention liability: each carries an ip address and a user agent for a
     * named person at a client firm.
     *
     * A day's grace rather than immediate deletion, so a support question about
     * a login that failed this morning can still be answered.
     */
    let pendingRemoved = 0;
    if (apply) {
      pendingRemoved = await mfa.purgeExpired({ olderThanHours: 24 });
      if (pendingRemoved) log(`removed ${pendingRemoved} expired second-factor challenges`);
    } else {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM mfa_pending WHERE expires_at < now() - interval '24 hours'");
      pendingRemoved = rows[0].n;
    }

    return { apply, tenants: report, expiredMfaChallenges: pendingRemoved };
  });
}

// ─── Offboarding ─────────────────────────────────────────────────────────────

/**
 * End a tenancy: block access, delete the tenant's rows, and destroy its data
 * key so that every copy of its payloads anywhere becomes unopenable.
 *
 * ORDER IS LOAD-BEARING. Access is cut BEFORE anything is deleted, so no live
 * request can write a new deal into a tenant halfway through being erased.
 *
 * The tenant ROW and its AUDIT ENTRIES are deliberately kept. Deleting the
 * tenant cascades to `audit_log` and would destroy the history of the
 * offboarding itself along with everything before it, breaking the global hash
 * chain from that point on. See the decision note at the top of this file.
 */
async function offboard({ slug, apply = false, reason = null, log = console.log } = {}) {
  if (!SLUG.test(String(slug || ''))) throw new Error('--slug is required');

  return withOwner(async (db) => {
    const t = await db.query(
      'SELECT id, slug, status, offboarded_at FROM tenants WHERE slug = $1', [slug]);
    if (!t.rows[0]) throw new Error(`no tenant with slug ${slug}`);
    const tenant = t.rows[0];

    const counts = await db.query(
      `SELECT (SELECT count(*) FROM deals          WHERE tenant_id = $1)::int AS deals,
              (SELECT count(*) FROM users          WHERE tenant_id = $1)::int AS users,
              (SELECT count(*) FROM firm_defaults  WHERE tenant_id = $1)::int AS "firmDefaults",
              (SELECT count(*) FROM tenant_domains WHERE tenant_id = $1)::int AS domains,
              (SELECT count(*) FROM sessions
                WHERE tenant_id = $1 AND revoked_at IS NULL)::int            AS "liveSessions",
              (SELECT count(*) FROM audit_log      WHERE tenant_id = $1)::int AS "auditEntries"`,
      [tenant.id],
    );
    const plan = { slug, ...counts.rows[0] };

    if (!apply) {
      log(`DRY RUN — offboarding ${slug} would delete ${plan.deals} deal(s), `
        + `${plan.users} user(s) and ${plan.domains} domain(s), revoke `
        + `${plan.liveSessions} session(s) and DESTROY the tenant data key. `
        + `${plan.auditEntries} audit entr(ies) would be RETAINED. Pass --apply.`);
      return {
        ...plan,
        dryRun: true,
        // Not `false`: nothing was attempted, so this is not a report that the
        // key survived an attempt to destroy it.
        keyDestroyed: null,
        offboardedAt: tenant.offboarded_at,
        auditEntriesRetained: plan.auditEntries,
      };
    }

    if (tenant.offboarded_at) {
      // Idempotent rather than an error: a runbook re-run must not look like a
      // second erasure, and there is nothing left to erase.
      log(`${slug} was already offboarded at ${tenant.offboarded_at.toISOString()}`);
      return { ...plan, dryRun: false, keyDestroyed: true, offboardedAt: tenant.offboarded_at,
        auditEntriesRetained: plan.auditEntries, alreadyOffboarded: true };
    }

    await db.query('BEGIN');
    try {
      // 1. Cut access first. Suspending stops session.resolve() dead on the next
      //    request; revoking ends the ones already in flight. Both, because
      //    either alone leaves a window.
      await db.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenant.id, 'suspended']);
      await db.query(
        'UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL',
        [tenant.id]);

      // 2. Delete the tenant's own rows. Order respects the foreign keys:
      //    deals reference users, so deals go first.
      const deals = await db.query('DELETE FROM deals WHERE tenant_id = $1 RETURNING id', [tenant.id]);
      const defaults = await db.query('DELETE FROM firm_defaults WHERE tenant_id = $1 RETURNING id', [tenant.id]);
      const domains = await db.query('DELETE FROM tenant_domains WHERE tenant_id = $1 RETURNING domain', [tenant.id]);
      const users = await db.query('DELETE FROM users WHERE tenant_id = $1 RETURNING id', [tenant.id]);

      // 3. CRYPTO-SHRED. The wrapped key is overwritten with NULL and the
      //    tombstone is stamped, so the row still says a key EXISTED and was
      //    destroyed on purpose. A deleted row would say only "no key", which
      //    the application reads as "issue one" — and issuing a new key for an
      //    offboarded tenant would quietly make it writable again.
      //
      //    With the local provider this is the end of it: the master key cannot
      //    open a wrapped key that no longer exists. With AWS KMS the wrapped
      //    blob is gone from here, and the key material is in a CMK whose own
      //    deletion is a separate, scheduled, attested operation — destroying
      //    this row is what makes the payloads unopenable regardless.
      const shred = await db.query(
        `UPDATE tenant_keys
            SET wrapped_key = NULL, destroyed_at = now(), destroyed_by = $2
          WHERE tenant_id = $1 AND destroyed_at IS NULL
      RETURNING tenant_id`,
        [tenant.id, reason || process.env.ADMIN_ACTOR || process.env.USER || 'unknown'],
      );

      // 3b. Destroy key material held OUTSIDE the database, where the provider
      //     can. This is what separates "erased from live systems" from "erased
      //     from every copy including backups", and only a per-tenant CMK earns
      //     the second. Failure is recorded, never swallowed: an erasure that
      //     half happened must not be reported as one that did.
      let material = { destroyed: false, reason: 'not-supported' };
      try {
        material = await keyProvider().destroyTenantKeyMaterial(tenant.id);
      } catch (err) {
        material = { destroyed: false, reason: `failed: ${err.message}` };
      }

      // 4. Mark the tenancy ended, distinctly from a reversible suspension.
      await db.query('UPDATE tenants SET offboarded_at = now() WHERE id = $1', [tenant.id]);

      // 5. The record, in the same transaction. If it cannot be written, none of
      //    the above happens.
      await auditOrFail(db, {
        tenantId: tenant.id,
        action: 'tenant.offboarded',
        subjectType: 'tenant',
        subjectId: slug,
        detail: {
          reason: reason || null,
          dealsDeleted: deals.rows.length,
          usersDeleted: users.rows.length,
          firmDefaultsDeleted: defaults.rows.length,
          domainsRemoved: domains.rows.length,
          // `false` here would be a claim that no key was destroyed. It is only
          // false when there was never a key to destroy — a tenant that never
          // wrote a deal — and that is worth telling apart.
          dataKeyDestroyed: shred.rows.length > 0,
          // WHAT WAS ACTUALLY ACHIEVED, not what the mechanism is called.
          // `reachesBackups: false` means the wrapped key is recoverable from a
          // snapshot and the honest promise is "erased from live systems;
          // backups expire on their own schedule". Recording the weaker truth
          // is the point — this entry is the evidence a customer would be shown.
          erasure: {
            reachesBackups: Boolean(keyProvider().shreddingReachesBackups && material.destroyed),
            keyMaterial: material,
            provider: keyProvider().name,
          },
          auditEntriesRetained: plan.auditEntries,
          // Said out loud in the record itself, because the entry is the thing
          // someone reads two years later when asked what "offboarded" meant.
          basis: keyProvider().shreddingReachesBackups && material.destroyed
            ? 'crypto-shredding with per-tenant key material destroyed: no copy '
              + 'of the database, including backups, can be opened again; audit '
            : 'erased from live systems; the wrapped key is recoverable from '
              + 'backups until they expire, so this is NOT crypto-shredding; audit '
            + 'entries are retained under data minimisation (detail records an '
            + 'email domain, never an address)',
        },
      });

      await db.query('COMMIT');
      log(`offboarded ${slug}: ${deals.rows.length} deal(s) deleted, data key `
        + `${shred.rows.length ? 'destroyed' : 'was never issued'}, `
        + `${plan.auditEntries} audit entr(ies) retained`);

      return {
        slug,
        dryRun: false,
        deals: deals.rows.length,
        users: users.rows.length,
        firmDefaults: defaults.rows.length,
        domains: domains.rows.length,
        liveSessions: plan.liveSessions,
        keyDestroyed: shred.rows.length > 0,
        auditEntriesRetained: plan.auditEntries,
      };
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

module.exports = {
  show, setRetention, purge, offboard,
  effectiveRetention, PLATFORM_DEFAULT_RETENTION_DAYS,
  __internals: { auditOrFail, SLUG },
};

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const run = {
    show: () => show(args),
    'set-retention': () => setRetention(args),
    purge: () => purge({ ...args, apply: args.apply === true }),
    offboard: () => offboard({ ...args, apply: args.apply === true }),
  }[command];

  if (!run) {
    console.error('commands: show | set-retention | purge | offboard');
    console.error('purge and offboard are DRY RUN unless --apply is given');
    process.exit(2);
  }
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
