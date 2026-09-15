'use strict';

/**
 * Verify the audit log's hash chain, on a schedule.
 *
 * Migration 003 gave the audit log tamper EVIDENCE: a database trigger chains
 * each entry's digest to the one before it, so altering or deleting a row
 * breaks every digest after it. That is a real property, and until this script
 * existed it was a property nobody was checking.
 *
 * An integrity control that is only verified when someone remembers to open the
 * admin screen is not an integrity control. It is a thing you discover was
 * already broken, months later, at the moment you most need it to have been
 * intact — which is exactly the position the chain was built to avoid. So this
 * runs unattended (infra/lib/platform.js schedules it daily on the same image
 * as the API) and writes a security event when it finds a break, which the
 * CloudWatch alarm turns into a page.
 *
 * WHAT A BREAK ACTUALLY MEANS, stated plainly because the alarm will one day
 * fire and someone will have to decide how alarmed to be: the chain is verified
 * from the earliest row forward, and the FIRST row's prev_hash is trusted
 * rather than verified — there is nothing before it to check it against. So a
 * break proves that a row was altered, deleted or inserted around the trigger
 * SINCE it was written. It does not prove who did it, and it cannot detect a
 * wholesale rewrite of the entire table by someone holding the owner credential
 * who recomputes every digest as they go. Tamper evidence, not tamper proofing.
 *
 * Run with no arguments. Exits 0 when intact, 1 when broken — so a scheduled
 * ECS task's exit code carries the same answer as the log line, and neither is
 * the only place it is recorded.
 */

const { unscoped } = require('../db/pool');
const { securityEvent } = require('../obs/securityLog');

/**
 * The event kind. NOT in obs/securityLog's KIND map, deliberately: that map is
 * for events the request path emits, and this is a batch job. The CloudWatch
 * filter in platform.js matches this literal, and the synth test asserts it.
 */
const AUDIT_CHAIN_BROKEN = 'audit_chain_broken';

/**
 * Runs UNSCOPED — no tenant context — and that is only safe because of
 * migration 008.
 *
 * The chain is global across tenants: entry 40's digest covers entry 39's
 * regardless of which firm each belongs to. But audit_log carries the
 * tenant_isolation policy under FORCE ROW LEVEL SECURITY, and audit_log_verify
 * was originally an INVOKER function — so read from this pool, with no tenant
 * set, the policy matched no rows at all, the loop never ran, and the function
 * returned its "intact" signal on a log it had not looked at.
 *
 * This was found by the test below, not by reading the SQL. Migration 008 makes
 * the function SECURITY DEFINER and admits its owner to SELECT, so it now walks
 * the whole chain from any caller. Without that migration this job is a daily
 * report that everything is fine, issued without checking — the most dangerous
 * possible form of a security control.
 */
async function verifyAudit({ log = console.log } = {}) {
  const db = unscoped();
  const { rows } = await db.query('SELECT broken_at, reason FROM audit_log_verify()');
  const broken = rows[0] || null;

  if (broken) {
    securityEvent(AUDIT_CHAIN_BROKEN, {
      brokenAt: broken.broken_at,
      reason: broken.reason,
    });
    return { intact: false, brokenAt: Number(broken.broken_at), reason: broken.reason };
  }

  // The healthy case is logged too, at info, and this is not noise: an operator
  // asked "when was the audit log last proven intact" needs an answer, and
  // "there is no alarm" does not distinguish a verified log from a job that
  // stopped running six weeks ago. The alarm in platform.js watches for the
  // ABSENCE of this line as well as for the presence of a break.
  log(JSON.stringify({
    level: 'info', evt: 'audit_verify', result: 'intact',
    at: new Date().toISOString(),
  }));
  return { intact: true, verifiedAt: new Date().toISOString() };
}

if (require.main === module) {
  verifyAudit()
    .then(async (r) => {
      if (!r.intact) {
        console.error(`AUDIT CHAIN BROKEN at entry ${r.brokenAt}: ${r.reason}`);
        console.error('See docs/runbooks/incident-response.md — this is a P1.');
      }
      await unscoped().end();
      process.exit(r.intact ? 0 : 1);
    })
    .catch(async (e) => {
      // A failure to VERIFY is not the same as a broken chain, and must not be
      // reported as one — a database that was unreachable for a minute would
      // otherwise page someone with "your audit log has been tampered with".
      console.error(JSON.stringify({
        level: 'error', evt: 'audit_verify', result: 'error', msg: e.message,
      }));
      try { await unscoped().end(); } catch { /* already closing */ }
      process.exit(2);
    });
}

module.exports = { verifyAudit, AUDIT_CHAIN_BROKEN };
