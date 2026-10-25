# CRE Deal Analyzer — multi-tenant API

Serves the underwriting app to multiple client firms over SSO, with tenant
isolation enforced by Postgres row level security.

## The one thing to understand before changing anything here

**Isolation is a property of the database, not of the routes.** Look at
`src/routes/deals.js`: not one query carries a `WHERE tenant_id = ...`
predicate. Row level security adds it, on every statement, whether or not the
person writing the route remembered to. A route that forgets returns *nothing*
rather than another firm's pipeline.

Two configuration facts make that true, and both are easy to undo by accident:

1. The API connects as `app_user`, which **does not own** the tables. A table's
   owner silently bypasses its own policies. Migrations run as the owner;
   requests never do.
2. `FORCE ROW LEVEL SECURITY` is set, so even the owner is subject to the
   policies — the guard for the day someone points the app at the owner role.

`test/isolation.test.js` asserts both directly, against a real Postgres. It is
mutation-verified: pointing the app at the owner role fails 11 of its 12 tests.

## Two database roles, deliberately

| role | can | cannot |
|---|---|---|
| `app_user` | read and write tenant data under RLS | read the `sessions` table **at all** |
| `auth_user` | read/write `sessions`, read the tenant registry and users | see a single deal |

Session lookup is what *discovers* the tenant, so it necessarily runs before any
tenant context exists — it cannot live under tenant RLS. The weak fix is to drop
RLS on `sessions`, or open it whenever no tenant is set; the second in
particular lets any route that forgets its context enumerate every live session
on the platform. Splitting the privilege instead means a flaw in the tenant path
cannot forge a session, and a flaw in the auth path cannot read a pipeline.
See `src/db/migrations/002_auth_role.sql`.

## Where the tenant comes from

The identity provider's assertion, via the broker's organization id. **Never**
from a header, query parameter, request body, subdomain, or anything else the
client controls. `src/auth/login.js` is the only file that decides this and
`src/auth/session.js` is the only file that reports it.

The `?org=` hint on `/auth/start` is a *routing* hint that selects which IdP to
send the user to. Tampering with it sends them to a directory that will refuse
to authenticate them; it cannot change what they can see. Pinned by
`test/auth.test.js` — "the tenant comes from the ASSERTION, not the hint".

## SSO

A broker (WorkOS) rather than per-tenant SAML code, because each client firm
arrives with a different identity provider and onboarding one should be
configuration, not a release. `src/auth/broker.js` holds the interface.

`SSO_PROVIDER=stub` is a **test fixture** — a fake IdP that mints an identity
from a staged profile, so the security decisions downstream of the handshake are
testable with no vendor account and no network. `src/config.js` refuses to boot
in production with it set, because it is a total authentication bypass. Do not
remove that guard.

Admitting a user to a tenant requires, in order: a valid single-use `state`, a
verified email from the IdP, a provisioned tenant for that organization, an
active tenant, and the email's domain **verified for that tenant**. The last is
the backstop against a misconfigured SSO connection dropping an outside address
into a client firm.

## Sign-in links, for firms with no identity provider

A second way in, enabled **per tenant** and off by default:

```sh
npm run tenants -- auth-methods --slug acme --methods sso,magic_link
```

`tenants.auth_methods` defaults to `{sso}`, so no existing firm is opted into a
weaker door by a migration. Enabling it is audited.

What makes it safe is where the tenant comes from, and it is worth being
explicit because this path has strictly less to work with than SSO:

| | SSO | sign-in link |
|---|---|---|
| tenant resolved by | the broker's organization id | the verified email domain |
| second, independent check | the verified email domain | *there isn't one* |

So the domain stops being a backstop and becomes the whole control. Hence:
a verified domain may belong to **one** firm (migration 011 adds the unique
index, and `magicLink.resolveTenantForEmail` refuses an ambiguous one anyway);
the tenant is frozen into the link when it is issued; and the domain, the
firm's status and its sign-in policy are **all re-checked when the link is
claimed**, because a link lives fifteen minutes and a firm can change posture
inside that window.

**A firm requiring MFA cannot be entered by a link unless it has Duo.**
`tenants.require_mfa` means "the identity provider asserted a second factor",
and a mailed link asserts nothing. Without that refusal, turning this feature
on would silently become the way to skip MFA — the policy is enforced in
`login.complete()` against the IdP's assertion, and that code never runs here.
A firm with Duo configured gets Duo on this path too.

`/auth/magic/start` always answers `202 {sent:true}` — for a real address, an
unknown one, a firm that has not opted in, and a suspended firm alike. Any
difference turns it into a customer list and a user directory, enumerable one
address at a time. The reasons are emitted as security events instead.

**No mail vendor is bundled.** `auth/mailer.js` is an interface with a stub for
tests, a `log` provider for local development, and a lazily-required SES
adapter that needs `npm i @aws-sdk/client-sesv2`. Pick a transport before
enabling this for a real firm; `MAIL_PROVIDER`, `MAIL_FROM` and
`MAGIC_LINK_CALLBACK_URL` are validated at first send rather than at boot, so a
deployment whose firms all use SSO never has to configure them.

## Running the tests

`npm test` carries `--test-timeout=60000`, and the number is not arbitrary.

This suite hung in CI for six hours on every run for months — "Set up job" and
"Initialize containers" both succeeded, `npm ci` succeeded, and then `Tests`
sat there until GitHub's maximum job runtime killed it and reported the job as
*cancelled*. Cancelled reads as "somebody stopped it", so nobody looked, and
the tenant isolation suite — the one thing standing between two client firms'
data — had never once actually run on a merge.

The whole suite finishes in about 16 seconds locally, so any single test taking
a minute is wedged. With the timeout, a hang fails as a NAMED test in a minute
instead of a silent six-hour cancellation.

It named it immediately, and the answer was three faults in the fixture rather
than anything in the suite:

1. **CI's Postgres service was created with `POSTGRES_USER: cre_owner`**, and
   the fixture connected as that role. `cre_owner` has to end up an ORDINARY
   role, because `FORCE ROW LEVEL SECURITY` does not bind to a superuser — and
   a role cannot be demoted out from under the session using it, so the
   demotion was refused. Note the alternative: had it instead succeeded
   silently, every isolation test here would have passed over a connection that
   bypasses the policies entirely, which is worse than the hang and quieter.
2. **A failed bootstrap left its pg client open**, and an open socket keeps the
   event loop alive. That is what turned a sixty-millisecond error into six
   hours of nothing.
3. **`app_user` and `auth_user` were created `NOLOGIN` and passwordless.** Only
   a superuser may set `NOSUPERUSER`, so migration 001 could not correct the
   attributes and refused the run — behaving exactly as designed, while the
   fixture was the thing not holding up its end.

All three are fixed here, and the fixture now VERIFIES that `cre_owner` ended
up an ordinary role rather than assuming the `ALTER` took — so the quiet
failure, a green suite over a connection that bypasses every policy, cannot
recur without saying so.

PR #2 fixes fault 1 independently and by the same means. Whichever of the two
lands second will conflict here trivially; either side's version of the service
configuration is correct, so take one. What is only in this version is the
try/finally and the verification.

Checked three ways rather than one, because the failure mode was a suite that
passed while proving nothing:

- CI's shape — a FRESH cluster holding none of these roles, over TCP with
  trust, superuser `postgres`: 315 pass, and `cre_owner` ends NOSUPERUSER and
  NOBYPASSRLS.
- The local shape — unix socket, trust: 315 pass.
- The old broken shape — superuser named `cre_owner`: fails in under a second
  with a message naming the cause and the fix, where it used to hang for six
  hours.



They need a real Postgres — RLS has several documented ways to silently not
apply, and a mock would confirm whatever the implementation believes.

```sh
initdb -D /tmp/pgdata --auth=trust          # as an unprivileged user
pg_ctl -D /tmp/pgdata -o "-p 5433 -k /tmp" start
npm test
```

Run **serially** (already set in `package.json`). Each file gets its own
database, but Postgres roles are cluster-wide, so the role statements in the
migrations collide across parallel files.

## Environment

| variable | notes |
|---|---|
| `DATABASE_URL` | as `app_user` |
| `AUTH_DATABASE_URL` | as `auth_user`; defaults to `DATABASE_URL` with the role swapped |
| `DATABASE_MIGRATION_URL` | as the table owner; migrations only |
| `SESSION_SIGNING_SECRET` | ≥32 bytes, required in production |
| `APP_ORIGIN` | exact browser origin; must be https in production |
| `SSO_PROVIDER` | `workos` in production |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI` | |

In AWS these come from Secrets Manager via the task definition. `app_user` and
`auth_user` hold no password of their own: both are granted `rds_iam` and the
task authenticates with a short-lived IAM token, so no long-lived database
credential exists in the image or the environment.

## Two modes, chosen by one variable

`REACT_APP_API_URL` decides how the SPA persists deals, and nothing else does:

| unset | **single-user** — localStorage, no server, samples seeded. Exactly what the app did before this API existed, and still supported: a solo analyst, a laptop demo, the test suite. |
| set | **multi-tenant** — this API, SSO required, deals isolated per firm. |

There is no runtime toggle. A persistence layer that can change under a running
app is a way to write into the wrong place, and in multi-tenant mode "the wrong
place" means a browser rather than a client firm's audited store.

The sample portfolio is seeded **only** in single-user mode. Nine fictional
deals in a client firm's pipeline is a support call at best, and at worst a memo
citing a deal that never existed.

## Not done yet

- **No real IdP handshake has ever run.** The sandbox this was built in has no
  outbound network, so `workosBroker()` is written against the documented API
  and exercised only through the stub. A wrong parameter name or a changed
  response shape would not have been caught. Treat a live connection test as a
  hard gate before onboarding a firm.
- **Nothing has been deployed.** `cdk synth` plus 16 assertions catches
  misconfiguration, not what only appears against real AWS.
- No deal-delete path in the UI, so `DELETE /api/deals/:id` is tested but
  unreachable from the app.
