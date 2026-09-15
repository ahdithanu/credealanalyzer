# Incident response

Written before it was needed, which is the only time it can be written. Most US
state breach laws run a notification clock from **discovery**, not from
resolution — drafting this during an incident is how that deadline is missed.

## Severity

| | Definition | Response |
|---|---|---|
| **SEV1** | Confirmed or suspected cross-tenant data exposure; any unauthorised access to client deal data; the audit chain fails verification. | Immediate. Page. Start the clock. |
| **SEV2** | Service down, or a security control confirmed not functioning (RLS bypassed, sessions not revoking, SCIM token leaked). | Within 1 hour. |
| **SEV3** | Degraded service, a control weakened but holding, a dependency advisory reachable in production. | Next business day. |

**A SEV1 is declared on suspicion, not on proof.** The cost of standing one down
is an hour. The cost of investigating for a day first is the notification clock.

## First fifteen minutes of a SEV1

1. **Write down the time you became aware.** Everything downstream is measured
   from it, and memory is not evidence.
2. **Preserve before you fix.** Snapshot the RDS instance, export the relevant
   CloudWatch logs. A restart destroys the evidence that explains what happened.
3. **Contain.** In order of reversibility:
   - Suspend the affected tenant: `npm run tenants -- suspend --slug <slug>`
     (blocks new requests immediately — `session.resolve()` checks tenant status
     on every call).
   - Revoke its live sessions: `npm run tenants -- revoke-sessions --slug <slug>`.
   - Only then consider scaling the service to zero. That is an outage for every
     firm and is rarely the right first move.
4. **Verify the audit chain** before relying on anything it says:
   `SELECT * FROM audit_log_verify();` — zero rows means intact.
5. **Open a log.** One file, append-only, timestamped. What you observed, what
   you did, what you concluded, in that order and kept separate.

## Notification

- **Contractual:** most DPAs commit to notifying the customer within 24–72 hours
  of becoming aware. Read the executed agreement; do not assume.
- **Statutory:** varies by the affected party's state, not yours. Involve a
  lawyer before the first customer communication.
- **Never speculate in writing** about cause or scope before the investigation
  concludes. An early wrong number is quoted back for years.

## Contacts

| Role | Who | Reach |
|---|---|---|
| Incident lead | *(fill in)* | |
| Legal | *(fill in)* | |
| AWS support | Business/Enterprise plan | Console → Support |
| WorkOS support | | support@workos.com |

> Filling this table in is part of the runbook, not preparation for it. An
> incident response plan with placeholder contacts is a document, not a plan.

## After

Write the post-incident review within five business days, while the detail is
still recoverable. Two questions: what let this happen, and what would have
caught it sooner. **No individual is named as a cause** — a review people are
afraid of is a review that stops being honest, and dishonest reviews are how the
same incident happens twice.
