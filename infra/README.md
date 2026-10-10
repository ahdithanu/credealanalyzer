# AWS infrastructure

Two stacks. `npx cdk synth` renders both; `test/synth.test.js` asserts security
properties against the **rendered CloudFormation**, not against the source — a
comment claiming the database is encrypted is worth nothing, what deploys is the
template.

```
CrePlatform      VPC · RDS Postgres · ECS Fargate · ALB · WAF · Secrets Manager
CreWeb           S3 (private) · CloudFront · security headers
```

## Why one platform stack and not three

They were three, and it does not work. Security groups are the reason, and it is
worth recording because splitting by concern is otherwise the right instinct: a
load balancer needs an ingress rule on the service's group, and the service
needs one on the database's group. Put the VPC in one stack and its consumers in
another and each stack ends up referencing a group ID in the other, which `cdk
synth` rejects as a dependency cycle — **whichever side owns which group**, so
moving the groups only moves the cycle.

`CreWeb` stays separate because it genuinely is: CloudFront and S3 share no VPC
resource with the platform and reference the API only by hostname.

## Deploying

```sh
npx cdk deploy --all \
  -c apiDomain=api.cre.example.com -c apiCertArn=arn:aws:acm:us-east-1:…:certificate/… \
  -c webDomain=app.cre.example.com -c webCertArn=arn:aws:acm:us-east-1:…:certificate/…
```

`apiCertArn` is **required**. Without a certificate the ALB pattern falls back
to an HTTP listener and the stack deploys perfectly happily — serving an API
whose entire authentication model is a session cookie, over plaintext. That
failure is invisible: everything works, and works insecurely. So the stack
refuses to synthesize instead. This was found by the test asserting every
listener is HTTPS, not by reading the code.

DNS is yours. `domainName` is deliberately not passed to the ALB pattern,
because given one it tries to create a Route53 alias record and demands a hosted
zone — assuming CDK owns the DNS. Point a CNAME or alias at the load balancer
output.

## The security properties worth knowing

**The database has no route to the internet.** Not merely private — the data
subnets are `PRIVATE_ISOLATED` with no NAT route at all, asserted by walking the
rendered route tables. An attacker who lands in an API task can reach Postgres,
because that is the API's job, but cannot exfiltrate from the database's subnet.

**No database password exists.** RDS IAM authentication, granted per database
role: two resource ARNs naming `app_user` and `auth_user`. Neither implies the
other and **neither implies the owner** — so a compromised task cannot connect
as the table owner and bypass row level security, which is the one credential
that would defeat the whole isolation design. `server/src/db/iamAuth.js` mints a
token per connection, because the token lives 15 minutes and a pool holds
connections for hours: minting once at startup would work for twenty minutes and
then fail as the pool recycled, which is the worst kind of outage because the
deploy looked fine.

**The WAF limits `/auth/` harder than everything else.** SSO login is the one
unauthenticated, database-touching endpoint — both a brute-force surface and a
cheap way to fill the `sso_states` table.

**The SPA's CSP names the API in `connect-src`.** The session cookie is
httpOnly, so injected script cannot read it, but it could still act as the user
inside the page. `connect-src` is what stops that script shipping a client
firm's pipeline to an attacker's host.

Note the build constraint that comes with it: `script-src` has no
`'unsafe-inline'`, so the React build needs `INLINE_RUNTIME_CHUNK=false` or the
app is a blank page with a console error.

## Cost, honestly

Two NAT gateways and a Multi-AZ `t4g.medium` RDS instance are the bulk of it,
roughly $200–250/month before traffic. The second NAT is not redundancy
theatre — a single NAT is a single point of failure for every outbound call the
API makes, including the SSO token exchange, so losing it logs out every firm.
Drop to one only if you accept that.

## Not verified

Nothing here has been deployed. `cdk synth` renders it and 16 tests assert the
output, which catches misconfiguration but not anything that only appears
against real AWS: IAM auth against a live RDS instance, the certificate and
listener actually serving, the WAF's managed rule groups against real traffic.
Treat the first deploy as the test it has not had.
