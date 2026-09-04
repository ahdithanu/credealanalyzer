# Deploying

Three options, cheapest first. Pick by what you need to show.

| | shows | cost | time |
|---|---|---|---|
| **A. Static demo** | the underwriting engine and all seven screens | free | ~5 min |
| **B. Local full stack** | SSO, multi-tenancy, isolation between two firms | free | ~3 min |
| **C. AWS** | the production architecture actually running | ~$200–250/mo | ~40 min |

**A and B together cover almost everything worth showing.** C proves it deploys,
which matters less than it sounds — the architecture is legible from `infra/` and
its tests, and a reviewer is far more likely to click a link than to read a
CloudFormation template.

---

## A. Static demo — a link anyone can click

Single-user mode: no server, no database, no login. Deals live in the browser.
Every screen, the whole engine, the sample portfolio.

```sh
npm ci
npm run build          # emits ./build
```

`build/` is plain static files with **relative** asset paths, so the same output
works at a domain root or a repo subpath without rebuilding. Drop it anywhere:

```sh
npx vercel deploy --prod build      # or: npx netlify deploy --prod --dir=build
```

For GitHub Pages, push `build/` to a `gh-pages` branch — the relative paths are
why it works under `/credealanalyzer/`.

---

## B. Local full stack — SSO and tenant isolation, in one command

```sh
docker compose up --build
open http://localhost:3000
```

Two demo firms are seeded. Sign in **in two separate browser windows** (or one
normal and one private — the session is a cookie, so two tabs share it):

| firm | email | organization |
|---|---|---|
| `firm-x` | `analyst@firmx.com` | `org_firm_x` |
| `firm-y` | `analyst@firmy.com` | `org_firm_y` |

Create a deal in one. It does not appear in the other. That is Postgres row
level security, not application code — `server/src/routes/deals.js` contains no
`WHERE tenant_id` predicate anywhere.

**The demonstration worth doing:** sign in with `analyst@firmx.com` against
organization `org_firm_y`. It is refused with `domain_not_verified` — the
backstop against a misconfigured SSO connection dropping an outside address into
a client firm's tenant.

The identity provider here is a fake page that mints an identity from a form
field. That is what makes this runnable with no accounts to create, and it is
why `server/src/config.js` refuses to boot with `NODE_ENV=production` and
`SSO_PROVIDER=stub`.

---

## C. AWS

### What you need first

- An AWS account with credentials configured (`aws sts get-caller-identity` works).
- **An ACM certificate** for the API hostname. Required — without one the load
  balancer serves the API over plaintext HTTP and its session cookies with it,
  so the stack refuses to synthesize rather than offer a deployable insecure
  mode.
- A WorkOS account for real SSO (skip for a portfolio deploy; see the note).

### Deploy

```sh
cd infra
npm ci
npx cdk bootstrap                      # once per account/region
npx cdk deploy --all \
  -c apiDomain=api.your-domain.com -c apiCertArn=arn:aws:acm:us-east-1:…:certificate/… \
  -c webDomain=app.your-domain.com -c webCertArn=arn:aws:acm:us-east-1:…:certificate/…
```

DNS is yours: point CNAMEs at the load balancer and CloudFront hostnames from
the stack outputs. CDK deliberately does not create Route53 records, because
that would assume it owns the zone.

### Then, once

```sh
# 1. Migrations, as the OWNER credential from Secrets Manager. The API tasks
#    never hold this — an owner bypasses its own row level security policies.
export DATABASE_MIGRATION_URL='postgres://cre_owner:…@…rds.amazonaws.com:5432/cre'
cd server && npm run migrate

# 2. Broker credentials
aws secretsmanager put-secret-value --secret-id <SsoSecretName from outputs> \
  --secret-string '{"WORKOS_API_KEY":"sk_…","WORKOS_CLIENT_ID":"client_…"}'

# 3. Onboard the first firm
npm run tenants -- create --slug acme --name "Acme Capital" --org org_…
npm run tenants -- verify-domain --slug acme --domain acme.com

# 4. The SPA
npm run build
aws s3 sync build/ s3://<SpaBucketName from outputs>/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths '/*'
```

### Before you point a real firm at it

**No live identity-provider handshake has ever run.** `workosBroker()` is written
against the documented API and exercised only through the stub, so a wrong
parameter name or a changed response shape would not have been caught. Run one
real login against your own directory first. This is the last genuinely
unverified thing in the system.

### Cost

Two NAT gateways and a Multi-AZ `t4g.medium` RDS instance are the bulk of it.
The second NAT is not redundancy theatre — one NAT is a single point of failure
for every outbound call the API makes, including the SSO token exchange, so
losing it logs out every firm. Drop to one only knowing that.

`cdk destroy` will **not** delete the database or the SPA bucket: both are
`RETAIN`, deliberately. Empty and delete them by hand when you actually mean it.
