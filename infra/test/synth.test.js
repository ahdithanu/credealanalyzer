'use strict';

/**
 * Assertions against the SYNTHESIZED CloudFormation, not the source.
 *
 * A comment in a CDK file claiming the database is encrypted is worth nothing;
 * what deploys is the template. Each test below picks a security property that
 * would be expensive to discover was missing — after a client firm's data was
 * already in it — and reads it out of the rendered resource.
 */

const test = require('node:test');
const assert = require('node:assert');
const cdk = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { PlatformStack } = require('../lib/platform');
const { WebStack } = require('../lib/web');

const app = new cdk.App();
const platform = new PlatformStack(app, 'TestPlatform', {
  env: { account: '111111111111', region: 'us-east-1' },
  domainName: 'api.test.example',
  certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/test',
  appOrigin: 'https://app.test.example',
});
const web = new WebStack(app, 'TestWeb', {
  env: { account: '111111111111', region: 'us-east-1' },
  apiOrigin: 'https://api.test.example',
});
const pt = Template.fromStack(platform);
const wt = Template.fromStack(web);

test('the database is encrypted, multi-AZ, and not publicly accessible', () => {
  pt.hasResourceProperties('AWS::RDS::DBInstance', {
    StorageEncrypted: true,
    MultiAZ: true,
    PubliclyAccessible: false,
    EnableIAMDatabaseAuthentication: true,
    DeletionProtection: true,
  });
});

test('the database is retained on stack deletion', () => {
  // A `cdk destroy` that silently drops client firms' deal history is not an
  // acceptable failure mode, and this is the only thing standing in the way.
  pt.hasResource('AWS::RDS::DBInstance', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
});

test('the database subnets have no route to a NAT gateway', () => {
  // The egress-less claim. If a route to a NAT ever appears in the data
  // subnets, an attacker in the database's network can reach the internet.
  const routes = pt.findResources('AWS::EC2::Route');
  const tables = pt.findResources('AWS::EC2::RouteTable');
  const dataTableIds = Object.entries(tables)
    .filter(([, r]) => JSON.stringify(r.Properties?.Tags || []).includes('data'))
    .map(([id]) => id);
  assert.ok(dataTableIds.length >= 2, 'expected an isolated route table per AZ');

  for (const [id, route] of Object.entries(routes)) {
    const table = route.Properties?.RouteTableId?.Ref;
    if (table && dataTableIds.includes(table)) {
      assert.ok(!route.Properties?.NatGatewayId, `route ${id} gives the data subnet a NAT route`);
      assert.ok(!route.Properties?.GatewayId, `route ${id} gives the data subnet an IGW route`);
    }
  }
});

test('only the API security group may reach Postgres, and only on 5432', () => {
  const ingress = pt.findResources('AWS::EC2::SecurityGroupIngress');
  const toDb = Object.values(ingress).filter((r) => r.Properties?.FromPort === 5432);
  assert.equal(toDb.length, 1, 'expected exactly one ingress rule to Postgres');
  const rule = toDb[0].Properties;
  assert.equal(rule.ToPort, 5432);
  assert.equal(rule.IpProtocol, 'tcp');
  // From a security group, never a CIDR. A CIDR here would admit anything that
  // happened to land in that address range.
  assert.ok(rule.SourceSecurityGroupId, 'Postgres ingress is not scoped to a security group');
  assert.ok(!rule.CidrIp, 'Postgres ingress admits a CIDR range');
});

test('the task role can connect as the two app roles and NOT as the owner', () => {
  // The privilege split from migration 002, expressed in IAM as well. If the
  // task could authenticate as the table owner it would bypass every row level
  // security policy, because an owner is exempt from its own policies.
  const policies = pt.findResources('AWS::IAM::Policy');
  const connect = Object.values(policies).flatMap((p) =>
    (p.Properties?.PolicyDocument?.Statement || [])
      .filter((s) => JSON.stringify(s.Action).includes('rds-db:connect')));
  assert.equal(connect.length, 1, 'expected one rds-db:connect statement');
  const resources = JSON.stringify(connect[0].Resource);
  assert.ok(resources.includes('app_user'), 'app_user not granted');
  assert.ok(resources.includes('auth_user'), 'auth_user not granted');
  assert.ok(!resources.includes('cre_owner'), 'the task can authenticate as the table owner');
  assert.ok(!resources.includes('dbuser:*'), 'the grant is a wildcard over every database role');
});

test('no database password reaches the task definition', () => {
  // The point of IAM auth. A password here is readable by anyone who can
  // describe the task definition, and lives until someone rotates it.
  const defs = pt.findResources('AWS::ECS::TaskDefinition');
  const rendered = JSON.stringify(Object.values(defs));
  assert.ok(!/DATABASE_URL/.test(rendered), 'a DATABASE_URL was baked into the task definition');
  assert.ok(!/DB_PASSWORD|PGPASSWORD/.test(rendered), 'a database password reached the task definition');
});

test('the session signing secret and broker key arrive as secrets, not plaintext', () => {
  const defs = Object.values(pt.findResources('AWS::ECS::TaskDefinition'));
  const container = defs[0].Properties.ContainerDefinitions[0];
  const secretNames = (container.Secrets || []).map((s) => s.Name);
  for (const name of ['SESSION_SIGNING_SECRET', 'WORKOS_API_KEY', 'WORKOS_CLIENT_ID']) {
    assert.ok(secretNames.includes(name), `${name} is not injected as a secret`);
  }
  const envNames = (container.Environment || []).map((e) => e.Name);
  for (const name of secretNames) {
    assert.ok(!envNames.includes(name), `${name} is ALSO in plaintext environment`);
  }
});

test('the stub SSO provider cannot be what deploys', () => {
  const defs = Object.values(pt.findResources('AWS::ECS::TaskDefinition'));
  const env = defs[0].Properties.ContainerDefinitions[0].Environment || [];
  const provider = env.find((e) => e.Name === 'SSO_PROVIDER');
  assert.equal(provider?.Value, 'workos', 'the deployed task would run the fake identity provider');
  // config.js refuses to boot with the stub when NODE_ENV is production, so
  // this pairing is the belt to that braces.
  assert.equal((env.find((e) => e.Name === 'NODE_ENV') || {}).Value, 'production');
});

test('the load balancer listens on https only', () => {
  const listeners = Object.values(pt.findResources('AWS::ElasticLoadBalancingV2::Listener'));
  assert.ok(listeners.length > 0);
  for (const l of listeners) {
    assert.equal(l.Properties.Protocol, 'HTTPS',
      'a plaintext listener would carry the first session cookie in the clear');
  }
});

test('the health check targets /healthz', () => {
  // The default is `/`, which this API answers with 404 — the service would
  // never come into service and the deploy would roll back with a healthy
  // container. A subtle, expensive misconfiguration.
  pt.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/healthz',
  });
});

test('the WAF rate-limits the auth path harder than the rest', () => {
  const acls = Object.values(pt.findResources('AWS::WAFv2::WebACL'));
  assert.equal(acls.length, 1);
  const byName = Object.fromEntries(acls[0].Properties.Rules.map((r) => [r.Name, r]));
  const general = byName.RateLimitPerIp?.Statement?.RateBasedStatement?.Limit;
  const auth = byName.RateLimitAuth?.Statement?.RateBasedStatement?.Limit;
  assert.ok(general > 0 && auth > 0, 'both rate limits must exist');
  assert.ok(auth < general,
    'SSO login is the one unauthenticated database-touching endpoint and must be limited harder');
  for (const name of ['AWSManagedCommon', 'AWSManagedBadInputs', 'AWSManagedSqli']) {
    assert.ok(byName[name], `${name} rule group missing`);
  }
});

test('the WAF is actually associated with the load balancer', () => {
  // A Web ACL that exists and is attached to nothing is the easiest security
  // control in AWS to believe you have.
  pt.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
});

test('the SPA bucket is private and the distribution sets a strict CSP', () => {
  wt.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true,
      IgnorePublicAcls: true, RestrictPublicBuckets: true,
    },
  });
  const policies = Object.values(wt.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
  assert.equal(policies.length, 1);
  const csp = policies[0].Properties.ResponseHeadersPolicyConfig
    .SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
  // connect-src is the control that stops injected script shipping a client
  // firm's pipeline to an attacker's host.
  assert.ok(csp.includes("connect-src 'self' https://api.test.example"), csp);
  assert.ok(csp.includes("frame-ancestors 'none'"), 'the app can be framed');
  assert.ok(!csp.includes("'unsafe-eval'"), 'unsafe-eval is permitted');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'inline script is permitted');
});

test('the SPA is served over https with HSTS', () => {
  wt.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
    }),
  });
  const p = Object.values(wt.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0];
  const hsts = p.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.StrictTransportSecurity;
  assert.ok(hsts.AccessControlMaxAgeSec >= 31536000, 'HSTS max-age under a year');
  assert.equal(hsts.IncludeSubdomains, true);
});

test('deep links resolve to the SPA without changing the URL', () => {
  // 200, not 302: the URL an analyst shared with their IC must stay intact.
  const d = Object.values(wt.findResources('AWS::CloudFront::Distribution'))[0];
  const responses = d.Properties.DistributionConfig.CustomErrorResponses;
  for (const code of [403, 404]) {
    const r = responses.find((x) => x.ErrorCode === code);
    assert.ok(r, `no custom response for ${code}`);
    assert.equal(r.ResponseCode, 200);
    assert.equal(r.ResponsePagePath, '/index.html');
  }
});

test('the stack refuses to deploy without a TLS certificate', () => {
  // The no-certificate case used to synthesize an HTTP listener — an API whose
  // whole authentication model is a session cookie, served in the clear, and
  // working well enough that nobody would notice. It is now a hard failure at
  // synth rather than a quiet one at runtime.
  const throwaway = new cdk.App();
  assert.throws(
    () => new PlatformStack(throwaway, 'NoCert', {
      env: { account: '111111111111', region: 'us-east-1' },
      appOrigin: 'https://app.test.example',
    }),
    /certificateArn is required/,
  );
});
