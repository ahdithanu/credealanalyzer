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
npm run build          # Vite; emits ./build
```

`build/` is plain static files with **relative** asset paths, so the same output
works at a domain root or a repo subpath without rebuilding. Drop it anywhere:

```sh
npx vercel deploy --prod build      # or: npx netlify deploy --prod --dir=build
```

For GitHub Pages, push `build/` to a `gh-pages` branch — the relative paths are
why it works under `/credealanalyzer/`.

### Three things about this build that are load-bearing

All three live in `vite.config.js`, not in `package.json`. The frontend used to
be Create React App, where the first two were a `homepage` field and an
environment variable; if you go looking for those, this is where they went.

- **Relative asset paths** come from `base: './'`. Absolute `/assets/…` paths
  404 under a repo subpath, which is the GitHub Pages case above.
- **No inline `<script>` in the built HTML.** The CloudFront distribution's CSP
  has no `'unsafe-inline'` on `script-src`, so one inlined script is a blank
  page and a console error — not a degraded page, a blank one. CRA needed
  `INLINE_RUNTIME_CHUNK=false` to avoid this; Vite emits no runtime chunk, so
  nothing has to be switched off. The thing that would reintroduce it is
  `@vitejs/plugin-legacy`, which injects two inline scripts of its own. CI
  asserts the built HTML on every push rather than trusting any of this.
- **`build/`, not Vite's default `dist/`,** because `Dockerfile.web` copies
  `./build` and the CI assertion greps `build/index.html`.

### The API URL keeps its old name

`REACT_APP_API_URL`, not Vite's `VITE_API_URL`. `vite.config.js` maps the
historical name onto what `src/lib/api.js` reads, so nothing about deploying
this changed when the build system did.

That is deliberate rather than lazy. The variable is already set in
`docker-compose.yml`, in `Dockerfile.web`'s build arg and in whatever pipeline a
deployment has wired up, and an **unset** value is not an error here — it is
single-user mode. A rename would therefore not fail anything. It would build
cleanly, deploy cleanly, and serve an app writing deals to `localStorage` while
the operator believed it was talking to their tenant's database.

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
  -c webDomain=app.your-domain.com -c webCertArn=arn:aws:acm:us-east-1:…:certificate/… \
  -c alertEmail=ops@your-domain.com \
  -c tier=lean            # optional; see Cost below. Default is production.
```

DNS is yours: point CNAMEs at the load balancer and CloudFront hostnames from
the stack outputs. CDK deliberately does not create Route53 records, because
that would assume it owns the zone.

`alertEmail` is where the 18 alarms go, and leaving it out is not harmless: the
alarms still deploy and still evaluate, and nobody is told when one fires. AWS
sends a confirmation email that must be clicked before the subscription is
live — an unconfirmed subscription is the same as none. The SNS topic is created
either way, so pointing PagerDuty or Opsgenie at it later is a subscription
rather than a change to the stack.

Email is stated plainly as inadequate for anything real: nobody is woken by it,
and an alarm at 02:00 is discovered at 09:00. See
`docs/runbooks/incident-response.md` for what each alarm means.

### Duo, per customer

Optional and per firm. A firm running Duo SSO — Duo as the SAML identity
provider behind the broker — needs none of this: Duo authenticates them before
the assertion ever reaches us, and enabling the step below would prompt them
twice. This is for the other case, which is the common one: a firm whose
directory is Entra ID or Okta with Duo layered on it, whose assertion does not
reliably carry an MFA claim, and who wants the second factor enforced at our
door rather than taken on trust.

In the customer's Duo Admin Panel they create a **Web SDK** application and give
you three values. The redirect URL they must register is in the stack outputs as
`DuoRedirectUri` — Duo compares it on both the authorize call and the token
exchange, so a mismatch is a login that fails at the last step with an opaque
error.

```sh
cd server
npm run duo -- set --slug acme \
  --api-host api-xxxxxxxx.duosecurity.com \
  --client-id <20 chars> --client-secret <40 chars>

npm run duo -- check  --slug acme     # a real health call to their Duo
npm run duo -- enable --slug acme
```

`set` deliberately does not enable it, and `enable` refuses a configuration that
has never passed `check`. Enabling puts a second factor in front of every user
at that firm; doing it on an unproven credential locks them all out.

The client secret is sealed with `DUO_CONFIG_KEY` (AES-256-GCM, the firm's
tenant id as additional authenticated data) before it touches the database, and
is never printed — `status` reports whether a secret is stored, never what it is.

**Fail mode** is `closed` by default: if Duo cannot be reached, the login does
not happen. Some firms ask for the opposite, because a Duo outage during an
investment committee meeting is a churn event:

```sh
npm run duo -- failmode --slug acme --mode open
```

Understand what that buys and costs. It admits users **only** when Duo is
unreachable — never when Duo was asked and refused — and every such login is
written to the customer's own audit log as `auth.mfa_failopen`, stamped
`duo_failopen` in `sessions.mfa_factor`, and raises the `MfaFailopen` alarm on
the first occurrence.

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

# 4. Confirm the audit chain verifies on the real database before anyone
#    relies on it. The daily scheduled task does this from here on.
npm run audit:verify

# 5. The SPA
npm run build
aws s3 sync build/ s3://<SpaBucketName from outputs>/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths '/*'
```

### Before you point a real firm at it: `npm run sso:check`

The SSO path is tested against a stub and a fake transport, which proves our
code is self-consistent and proves nothing about WorkOS. This turns "discovered
by a client firm's first login" into one command:

```sh
cd server
SSO_PROVIDER=workos WORKOS_API_KEY=sk_… WORKOS_CLIENT_ID=client_…   npm run sso:check
```

Without a code it verifies what needs no browser: the credentials are accepted,
the endpoint is where we think it is, and what shape their errors take. It
**requires positive evidence** — a JSON error naming the code as the problem,
which only WorkOS produces. A proxy or WAF answering with HTML is reported as
"this did not come from WorkOS", not as a pass. (An earlier version got that
wrong and printed PREFLIGHT PASSED from behind an egress proxy it never got
through. A preflight that passes when the network is blocked is worse than
none, because someone acts on it.)

To check the response **shape** — the thing that would otherwise surface as a
misleading "your identity provider did not identify your organization" — capture
a real authorization code and pass it:

```sh
npm run sso:check -- --code=<code from the callback of a real sign-in>
```

That does the full exchange and prints the parsed profile field by field, so a
renamed field is visible immediately. Codes are single-use and expire in
minutes; run it straight away.

### Cost, and the two tiers

Two NAT gateways and a Multi-AZ `t4g.medium` RDS instance are the bulk of the
production bill — roughly **$250–300/month** before traffic.

```sh
npx cdk deploy --all -c tier=lean   …        # roughly $50–60/month
```

| | production (default) | lean |
|---|---|---|
| NAT gateways | 2 | **0** |
| API task placement | private subnet, no public IP | **public subnet, public IP** |
| Tasks | 2, autoscaling to 10 | 1, autoscaling to 4 |
| Database | Multi-AZ `t4g.medium`, 100 GB | single-AZ `t4g.micro`, 20 GB |
| Backups | 30 days | 7 days |

**What lean does not give up.** Row level security and the two-role split,
envelope encryption of deal payloads, the WAF and all five rules, IAM database
authentication, every alarm, the audit chain and its daily verification,
TLS-only, deletion protection, `RETAIN` on the database — and the egress-less
data subnet. The database still has no route to anywhere in either tier, which
is the claim the security register actually makes.

**What it gives up**, in full:

1. **The API task runs in a public subnet with a public IP.** That is what
   removes the NAT gateway. It is not reachable from the internet — its security
   group admits the load balancer and nothing else, and `synth.test.js` asserts
   every ingress rule to it comes from a security group rather than a CIDR — but
   it is protected by a security group instead of by having no route. That is a
   weaker position and it is the real trade.
2. **Single-AZ database.** A failover becomes a restore: minutes rather than
   seconds, and the RPO is whatever the last backup holds rather than five
   minutes.
3. **One task.** A deploy is a brief interruption; a crash is an outage until
   ECS replaces it.
4. Smaller instance, less storage headroom, 7-day backups.

Nothing on that list except the first is a security control, and the list is
asserted in `infra/test/synth.test.js` so it cannot quietly grow — the tests
synthesize both tiers and check every other property against both.

**Use lean for a demonstration, a staging environment, or a first customer who
has been told.** If a client firm's deal data is going into it, deploy
`production`: single-AZ means an availability-zone failure is a restore from
backup, and a public task is one security-group mistake from being reachable.

`cdk destroy` will **not** delete the database or the SPA bucket: both are
`RETAIN`, deliberately. Empty and delete them by hand when you actually mean it.
