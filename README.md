# CRE Deal Analyzer

Institutional underwriting for commercial real estate: a monthly discrete-period
model across construction or renovation, an operating hold and a sale, with an
LP/GP promote waterfall, an IC memorandum, and a multi-tenant backend that lets
separate firms use it without seeing each other's deals.

```
1,068 frontend tests · 58 server tests · 16 infrastructure tests
```

**Run it:** [`DEPLOY.md`](DEPLOY.md) — static demo in ~5 minutes, or the full
multi-tenant stack with `docker compose up --build`.

---

## What is actually interesting here

Most of the engineering in this repository is about **not stating things that
are not true**. A financial model is a machine for producing confident numbers,
and the failure mode that matters is not a crash — it is a plausible figure that
nobody questions.

Four examples, each found by a test rather than by reading:

**An IRR of 409,500%.** The bisection solver evaluated NPV at −99.99%, which on
a long schedule divides a late cash flow by ~1e-308. With flows of both signs
that is `Infinity - Infinity` — `NaN`. `NaN` fails every comparison, so the
bracket guard `fLo * fHi > 0` was false, the no-root check never fired, and
bisection returned a bound instead of a root. It appeared on 52 of 396 sampled
parameter combinations, on the first tile of the deal screen, in the memo, the
CSV and the tornado. Now only finite evaluations may bracket, and the returned
rate is verified to zero the NPV.

**A green PASS on the investment committee memo** for a covenant that could not
be computed, because `null <= limit` is `true` in JavaScript.

**A portfolio return of 3.4%** where the one deal that could be priced returned
22.1% — the pipeline header weighted `(irr ?? 0)`, so a deal the engine could
*not* solve entered the average as 0%. It read as a measurement.

**A 312 bps gap between two numbers in the same exported row.** In-place NOI
during renovation netted operating expense only; the going-in cap rate netted
tax and reserves too. Both described the same income on the same basis. Closing
it revealed the real cost: that overstated income had been servicing
construction interest it could not service, so less interest capitalised, basis
was understated, and every return measured against it was flattered.

The convention throughout: **a figure that needs a schedule that was never built
is `null`, never `0`.** Zero is a claim.

---

## Architecture

```
src/lib/finance.js        the engine — monthly schedule, IRR by bisection
src/lib/waterfall.js      LP/GP promote: pref, return of capital, catch-up, clawback
src/lib/screen.js         fast sourcing screen, one arithmetic pass, no schedule
src/lib/memo.js           the IC memorandum
src/pipeline/             market data: property graph + bitemporal fact store
src/screens/              seven screens (Pipeline, Model, Cash Flow, …)
server/                   multi-tenant API — SSO, sessions, isolation
infra/                    AWS CDK: VPC, RDS, Fargate, ALB+WAF, CloudFront
```

### Isolation is a property of the database

`server/src/routes/deals.js` contains **no `WHERE tenant_id` predicate
anywhere**. Postgres row level security adds it to every statement, so a route
that forgets returns *nothing* rather than another firm's pipeline. One
forgotten predicate in one query is a client-confidentiality incident, and code
review does not catch every one of them forever.

Two configuration facts make that true, both easy to undo by accident: the API
connects as a role that does **not own** the tables (an owner silently bypasses
its own policies), and `FORCE ROW LEVEL SECURITY` is set. Both are asserted
directly — pointing the app at the owner role fails 11 of 12 isolation tests.

### Two database roles

| role | can | cannot |
|---|---|---|
| `app_user` | read/write tenant data under RLS | read the `sessions` table **at all** |
| `auth_user` | read/write sessions, resolve identities | see a **single deal** |

Session lookup is what *discovers* the tenant, so it runs before any tenant
context exists and cannot live under tenant RLS. The weak fixes — dropping RLS
on `sessions`, or opening it when no tenant is set — let any route that forgets
its context enumerate every live session on the platform. Splitting the
privilege means a flaw in one path is not a flaw in both.

### The tenant comes from the identity provider

Never a header, query parameter, body field or subdomain. The `?org=` hint on
`/auth/start` only selects which directory to redirect to; tamper with it and
you reach one that will refuse you. Admission requires a single-use `state`, a
verified email, a provisioned and active tenant, and the email's domain
**verified for that tenant** — the last being the backstop against a
misconfigured SSO connection dropping an outside address into a client firm.

---

## Testing

Tests are mutation-verified where the claim matters: the code is broken
deliberately and the suite must go red. That is how the portfolio-return bug
above was found — the fix passed, and the existing test *still* passed, because
it built its portfolio entirely from incomplete deals where the bug was
unreachable.

Database tests run against a **real Postgres**, not a mock. Row level security
has several documented ways to silently not apply, and a mock would confirm
whatever the implementation believes.

```sh
npm test                      # frontend
cd server && npm test         # API + isolation (needs Postgres; see server/README.md)
cd infra  && npm test         # asserts against synthesized CloudFormation
```

---

## Status, honestly

Built and verified end to end **locally**: the full SSO handshake, two firms
signed in simultaneously with disjoint pipelines, cross-tenant reads returning
404, and a wrong-domain login refused.

Not yet verified:

- **No live identity-provider handshake.** The WorkOS client is written against
  the documented API and exercised only through a stub. A wrong parameter name
  would not have been caught. This is the one thing to test before a real firm
  uses it.
- **Never deployed to AWS.** `cdk synth` plus 16 assertions catches
  misconfiguration, not what only appears against live infrastructure.
- The market-data pipeline has made **zero network calls** — it was built in a
  sandbox with no egress. Its parsers are tested against recorded fixtures.

A note on the sample deals: they are tuned to be *plausible*, not flattering.
One is deliberately thin — negative development spread, a coverage breach — and
documented as such, because a sample portfolio of nine winners teaches an
analyst that the screen never fires.
