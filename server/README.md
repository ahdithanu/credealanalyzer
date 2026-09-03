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

## Running the tests

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

## Not done yet

- The SPA still reads and writes `localStorage`; it is not yet wired to this API.
- No IaC in this commit — the AWS footprint (ECS Fargate, ALB + WAF, RDS,
  CloudFront) is described above but not yet expressed as CDK.
- No real IdP handshake has ever run. The sandbox this was built in has no
  outbound network, so `workosBroker()` is written against the documented API
  and exercised only through the stub. It needs a live connection test before
  anyone relies on it.
