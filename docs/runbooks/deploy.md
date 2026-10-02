# Getting it live

Two different things are called "live", and they cost very different amounts.

| | you, screening deals | the product, sold to firms |
|---|---|---|
| infrastructure | none — a static file host | VPC, RDS, ECS, CloudFront, WAF |
| sign-in | none, data in your browser | Duo MFA + WorkOS SSO, per-tenant |
| running cost | $0–1/mo | ~$120–180/mo on the lean tier |
| time to first use | ~10 minutes | half a day, plus DNS and certs |

Path A does not block Path B and nothing is thrown away: the same build artefact
serves both.

---

## Path A — your own deal screening, today

Single-user mode keeps deals in `localStorage` and calls no API. It is what the
app does when `REACT_APP_API_URL` is unset — **that name, not Vite's
`VITE_API_URL`**. `vite.config.js` maps the REACT_APP_ prefix onto the
identifier `src/lib/api.js` reads, deliberately, so an existing Docker build
arg keeps working. Setting the Vite-convention name instead does not fail the
build: it starts the app against localStorage while you believe it is talking
to your API.

```sh
npm install
npm run build          # → build/
```

`build/` is static. Any host will do — S3 + CloudFront, Netlify, Vercel, GitHub
Pages, or `npx vite preview` on your own machine.

### Automated, on GitHub Pages

`.github/workflows/pages.yml` does the above on every push to `main`: it runs
the suite, builds, asserts the bundle carries no inline script, and publishes
`build/`. Pages is the default here because the repository is already on
GitHub — no second vendor, no account, no card — and because `vite.config.js`
already sets `base: './'` so one artefact serves both a domain root and the
`/credealanalyzer/` subpath a Pages project site lives under.

Two steps cannot be done from a workflow file and have to be done once, by
hand, in the repository's settings:

1. **Settings → Pages → Source → GitHub Actions.** Until this is set the
   workflow runs green and publishes nothing.
2. **Make sure `main` holds the code you want served.** This is the one that
   actually bites: a host serves the branch it is pointed at, so moving hosts
   changes nothing if `main` is behind. Check with
   `git log --oneline origin/main -1` before assuming a deploy is stale.

To point the static build at a deployed API later, set the repository
variable `REACT_APP_API_URL` (Settings → Secrets and variables → Actions →
Variables). The workflow passes it through under that exact name.

**Know what you are getting.** No sign-in, no server, no backup. The deals live
in one browser profile on one machine, and clearing site data deletes them.
Export the ledger regularly. That is fine for screening your own pipeline and is
not fine for anything with a second user.

---

## Path B — the multi-tenant product on AWS

### What you need first

1. **An AWS account**, and `aws configure` done.
2. **Two hostnames**, e.g. `app.yourfirm.com` (web) and `api.yourfirm.com`.
3. **Two ACM certificates.** The web one **must be issued in `us-east-1`** —
   CloudFront reads certificates from nowhere else, and this is the single
   most common way this deploy fails. The API one goes in your deploy region.
4. **A WorkOS account** for SSO, if you are selling to firms that want it.
5. **A Duo account** per client firm, for MFA.

### Check before you deploy

```sh
cd infra
npm ci
npm run preflight -- \
  -c tier=lean \
  -c apiCertArn=arn:aws:acm:us-east-2:…:certificate/… \
  -c webCertArn=arn:aws:acm:us-east-1:…:certificate/… \
  -c alertEmail=you@yourfirm.com
```

Read-only, takes seconds, and takes the same `-c` arguments as `cdk deploy` so
the line copies straight across. It checks the four things that otherwise fail
*after* CloudFormation has started changing resources:

- **the web certificate's region** — ACM issues it anywhere, CDK accepts the
  ARN, and CloudFront rejects it twenty minutes in;
- **certificate status** — a `PENDING_VALIDATION` certificate deploys fine and
  then serves nothing;
- **CDK bootstrap** — missing, this fails at asset publishing, after synthesis;
- **Docker** — the API image is built from `../server` mid-deploy.

It reports every problem in one pass rather than one per run.

### Deploy

```sh
npx cdk bootstrap                       # once per account/region

npx cdk deploy --all \
  -c tier=lean \
  -c apiDomain=api.yourfirm.com  -c apiCertArn=arn:aws:acm:us-east-2:…:certificate/… \
  -c webDomain=app.yourfirm.com  -c webCertArn=arn:aws:acm:us-east-1:…:certificate/… \
  -c alertEmail=you@yourfirm.com
```

`apiCertArn` is **required**. Without it the stack refuses to synthesize rather
than serving session cookies over plaintext HTTP.

`tier=lean` drops the NAT gateways and Multi-AZ — about $250/month — by putting
the API task in a public subnet behind its security group. What that gives up is
listed at the top of `infra/lib/platform.js` and asserted by a test so the list
cannot quietly grow.

### Then, in order

**1. Run the migrations.** The database deploys empty; nothing works until this
runs. The stack prints the exact command as the `RunMigrations` output:

```sh
aws cloudformation describe-stacks --stack-name CrePlatform \
  --query "Stacks[0].Outputs[?OutputKey=='RunMigrations'].OutputValue" --output text
```

Run what it prints. It is a one-off ECS task on its own task definition — the
only thing in the stack holding the database owner credential, because the API
deliberately cannot create a table. It does **not** run automatically: a
migration that runs itself runs during an incident and during a rollback too.

**2. Fill in the WorkOS secret.** The stack creates it empty:

```sh
aws secretsmanager put-secret-value --secret-id <SsoSecret ARN from outputs> \
  --secret-string '{"WORKOS_API_KEY":"sk_…","WORKOS_CLIENT_ID":"client_…"}'
```

`SESSION_SIGNING_SECRET` and `DUO_CONFIG_KEY` are generated by the stack and
should never be typed. Both are `RETAIN` on delete — losing `DUO_CONFIG_KEY`
means asking every customer for a fresh Duo credential.

**3. Point DNS** at the ALB and the CloudFront distribution (both in outputs).

**4. Create a tenant and configure its Duo.**

```sh
npm run tenants -- create --name "Rivera Capital" --slug rivera --domain riveracapital.com
npm run duo -- add --slug rivera --api-host api-XXXXXXXX.duosecurity.com \
  --client-id … --client-secret …
npm run duo -- check --slug rivera
```

**5. Confirm the alert subscription.** `alertEmail` sends a confirmation you
have to click, and until you do, twenty alarms evaluate and tell nobody.

### Verify before you invite anyone

```sh
npm run audit:verify          # hash chain intact
npm run sso:check -- --code=… # a real WorkOS round trip
npm run duo -- check --slug rivera
```

---

## What is still not done

Deploying does not make these true, and two of them are what enterprise buyers
ask for:

- **No penetration test.** ~$8–20k, and the report is what a security
  questionnaire wants to see.
- **No SOC 2.** Type II needs a 6–12 month observation window, so it is the
  longest pole by a wide margin. Start it before you need it.
- **No DPA, ToS, privacy policy or subprocessor list.** Lawyer, not code.
- **The market table is seed data.** See `docs/market-data.md`. Property tax
  rates drive the NOI on every deal; they are estimates until sourced.
- **The DOT traffic endpoints have never been called.** Every one is marked
  `verified: false`.
