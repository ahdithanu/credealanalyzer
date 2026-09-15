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
   `npm run audit:verify` in `server/` — exit 0 intact, 1 broken, 2 could not
   check. A break names the first entry that fails and everything after it is
   unproven; entries before it are still evidence. The same check runs daily on
   a schedule, so `AuditVerifyStalledAlarm` firing means the chain is
   **unverified**, which is not the same as broken and must not be reported as
   if it were.
5. **Open a log.** One file, append-only, timestamped. What you observed, what
   you did, what you concluded, in that order and kept separate.

## What the alarms mean

Defined in `infra/lib/platform.js`, delivered to the SNS topic named by
`-c alertEmail`. The security ones are metric filters over structured events the
API emits (`server/src/obs/securityLog.js`); the log line always carries more
than the alarm does, and reading it is the first step for every one of them.

**Thresholds are reasoned, not measured.** Nothing has been deployed and no real
traffic has passed through this system. Expect to tune everything except the
first two in the first fortnight of real use.

| Alarm | What it means | First move |
|---|---|---|
| `AuditChainBroken` | An audit entry was altered, deleted, or inserted around the trigger. **SEV1.** | Preserve first: snapshot RDS before anything else. The alarm names the entry. |
| `AuditVerifyStalled` | The daily verification has not reported in 26 hours. The chain is unverified — not proven broken. | Check the scheduled ECS task ran. Run `npm run audit:verify` by hand. |
| `ScimAuthFailed` | Repeated failures against a provisioning token, which can enumerate and deactivate every user in a tenant. | `tokenId` is in the log. Revoke it (`npm run scim-tokens -- revoke --token-id <id>`) and ask the customer whether it was them. |
| `CsrfRejected` | Sessions arriving without a valid CSRF token. A real browser that has one has the other. | Read `presented`: `absent` suggests a broken client, `invalid` suggests forgery. |
| `OriginRejected` | State-changing requests from a site that is not the app. | The rejected origin is in the log and names the site. |
| `LoginFailed` | Sustained SSO refusals. Two evaluation periods, because this is the noisiest metric here. | Read `code`. `domain_not_verified` in volume = an SSO connection pointed at the wrong organization. `bad_state` = replay. |
| `RoleDenied` | A known user repeatedly reaching past their role. | The user and tenant ids are in the log. One is a mis-click; a stream is someone mapping their permissions. |
| `CspViolation` | Browsers are reporting blocked resources. | Read `blockedURI`. An external host is attempted injection or exfiltration. A `chrome-extension://` URL is noise. |
| `RateLimited` | Sustained throttling. | `limiter` names which ceiling. Cross-check the WAF. |
| `WafAuthBlocked` | The WAF is blocking sustained traffic to `/auth/`. The control is working. | Not an outage. Check whether one address or many. |
| `ServerError`, `Alb5xx` | The API is failing. `Alb5xx` fires when there is no healthy target at all. | Ordinary availability incident; `Alb5xx` without `ServerError` means nothing is running to log it. |
| `UnhealthyHosts` | A task is failing its health check. Below two, there is no redundancy. | Check the deploy and the task logs. |
| `DbCpu`, `DbStorage`, `DbMemory`, `DbConnections` | The database. `DbStorage` firing means autoscaling has failed and writes stop when it reaches zero. | Capacity, not security — unless it is a symptom of the export endpoint being abused. |

One thing the alarms cannot tell you: **`SessionRejected` is not alarmed on.**
Every anonymous page load produces one, so a threshold that caught an attack
would also catch a Monday morning. The events are in the log and `hadCookie`
distinguishes "not signed in yet" from "presented a token that did not work" —
use it during an investigation, do not expect to be paged on it.

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
