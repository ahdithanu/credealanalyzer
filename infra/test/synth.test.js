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
  alertEmail: 'ops@test.example',
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


// ─── Monitoring ──────────────────────────────────────────────────────────────
/**
 * These tests are the infrastructure half of a contract whose other half lives
 * in server/src/obs/securityLog.js.
 *
 * A CloudWatch metric filter matches a LITERAL field name in a log line. If the
 * server renames `kind`, or renames one of its values, every alarm keyed on it
 * keeps deploying, keeps evaluating, and never fires again. Nothing goes red.
 * The console shows a healthy row of alarms in OK, and the first anyone learns
 * of it is the incident the alarm existed to catch.
 *
 * So the names are pinned on both sides: server/test/observability.test.js
 * asserts what is emitted, and these assert what is matched. Renaming either
 * without the other turns one suite red.
 */

/** Pull the filter patterns out of the rendered template, keyed by metric. */
function metricFilters(template) {
  const out = {};
  for (const r of Object.values(template.findResources('AWS::Logs::MetricFilter'))) {
    for (const t of r.Properties.MetricTransformations) {
      out[t.MetricName] = { pattern: r.Properties.FilterPattern, transform: t };
    }
  }
  return out;
}

test('the security metric filters match the events the server actually emits', () => {
  const filters = metricFilters(pt);
  // The right-hand side is the string server/src/obs/securityLog.js writes into
  // the `kind` field. Both are spelled out rather than imported, because a
  // shared constant would let a rename satisfy both sides at once and defeat
  // the entire point of pinning them.
  const expected = {
    CsrfRejected: 'csrf_rejected',
    OriginRejected: 'origin_rejected',
    LoginFailed: 'login_failed',
    ScimAuthFailed: 'scim_auth_failed',
    RoleDenied: 'role_denied',
    RateLimited: 'rate_limited',
    CspViolation: 'csp_violation',
    ServerError: 'server_error',
    AuditChainBroken: 'audit_chain_broken',
  };
  for (const [metric, kind] of Object.entries(expected)) {
    const f = filters[metric];
    assert.ok(f, `no metric filter produces ${metric}`);
    assert.ok(f.pattern.includes('$.evt = "security"'),
      `${metric} does not require the evt discriminator: ${f.pattern}`);
    assert.ok(f.pattern.includes(`$.kind = "${kind}"`),
      `${metric} matches the wrong kind: ${f.pattern}`);
  }
});

test('a quiet security metric reports zero rather than nothing', () => {
  // Without an explicit default, a period with no matching line produces NO
  // datapoint, and the alarm on it sits in INSUFFICIENT_DATA instead of OK. On
  // a console of grey alarms, "nothing is attacking us" and "this alarm has
  // been broken for a month" look identical.
  const filters = metricFilters(pt);
  for (const metric of ['CsrfRejected', 'LoginFailed', 'AuditChainBroken']) {
    assert.equal(filters[metric].transform.DefaultValue, 0,
      `${metric} has no default value`);
  }
});

test('the audit-verification heartbeat has NO default value', () => {
  // The exact opposite of the rule above, and deliberately so. This metric is
  // watched for ABSENCE — the alarm fires when the daily job stops reporting.
  // A default of zero would emit a datapoint every period, the alarm would
  // always have data, and the one thing it exists to detect would never happen.
  const filters = metricFilters(pt);
  assert.ok(filters.AuditVerifyRan, 'no heartbeat filter');
  assert.equal(filters.AuditVerifyRan.transform.DefaultValue, undefined);
});

test('every alarm notifies on recovery as well as on failure', () => {
  // An alarm with no OK action tells you an incident began and never that it
  // ended. Teams stop trusting alarms they are never told the end of.
  const alarms = pt.findResources('AWS::CloudWatch::Alarm');
  assert.ok(Object.keys(alarms).length >= 15, 'suspiciously few alarms');
  for (const [id, a] of Object.entries(alarms)) {
    assert.ok(a.Properties.AlarmActions?.length, `${id} has no alarm action`);
    assert.ok(a.Properties.OKActions?.length, `${id} has no OK action`);
    assert.ok(a.Properties.AlarmDescription,
      `${id} has no description — an operator paged at 03:00 gets a metric name and nothing else`);
  }
});

test('a broken audit chain alarms on a single occurrence', () => {
  const alarm = Object.values(pt.findResources('AWS::CloudWatch::Alarm'))
    .find((a) => a.Properties.MetricName === 'AuditChainBroken');
  assert.ok(alarm);
  // There is no acceptable rate of audit-log tampering. Any threshold above
  // zero, or any requirement for a second occurrence, is a tolerance for it.
  assert.equal(alarm.Properties.Threshold, 0);
  assert.equal(alarm.Properties.EvaluationPeriods, 1);
  assert.equal(alarm.Properties.ComparisonOperator, 'GreaterThanThreshold');
});

test('the audit chain is verified on a schedule, not on request', () => {
  // Tamper evidence nobody checks is not tamper evidence. Before this, the
  // chain was verified only when an admin happened to open the integrity screen.
  const rules = Object.values(pt.findResources('AWS::Events::Rule'))
    .filter((r) => r.Properties.ScheduleExpression);
  assert.equal(rules.length, 1, 'expected exactly one scheduled job');
  const rule = rules[0];
  assert.match(rule.Properties.ScheduleExpression, /^cron\(/);
  assert.equal(rule.Properties.State, 'ENABLED');
  const override = JSON.stringify(rule.Properties.Targets[0].InputTransformer
    || rule.Properties.Targets[0].Input
    || rule.Properties.Targets[0].EcsParameters);
  // The command override travels in the target's Input, as a JSON document.
  const input = JSON.stringify(rule.Properties.Targets[0]);
  assert.ok(input.includes('verifyAudit.js'),
    `the scheduled task does not run the verifier: ${override}`);
});

test('alarms have somewhere to go', () => {
  pt.resourceCountIs('AWS::SNS::Topic', 1);
  pt.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email', Endpoint: 'ops@test.example',
  });
});

test('the API log group is retained and kept for a year', () => {
  // The security events are the evidence. A `cdk destroy` must not take them,
  // and a 30-day default would mean an intrusion discovered in month two has no
  // record of month one.
  const groups = Object.values(pt.findResources('AWS::Logs::LogGroup'));
  assert.ok(groups.length >= 1);
  for (const g of groups) {
    assert.equal(g.Properties.RetentionInDays, 365);
    assert.equal(g.DeletionPolicy, 'Retain');
  }
});

test('the WAF alarm names dimensions that will actually resolve', () => {
  // AWS documents the WebACL and Rule dimensions as the VisibilityConfig metric
  // names; plenty of example code treats them as resource names. An alarm on
  // the wrong one deploys, evaluates, and sits in INSUFFICIENT_DATA forever.
  // Making both spellings identical means it binds under either reading.
  const acl = Object.values(pt.findResources('AWS::WAFv2::WebACL'))[0].Properties;
  assert.equal(acl.Name, acl.VisibilityConfig.MetricName);
  for (const rule of acl.Rules) {
    assert.equal(rule.Name, rule.VisibilityConfig.MetricName,
      `rule ${rule.Name} has a metric name that differs from its name`);
  }
  const alarm = Object.values(pt.findResources('AWS::CloudWatch::Alarm'))
    .find((a) => a.Properties.MetricName === 'BlockedRequests');
  const dims = Object.fromEntries(alarm.Properties.Dimensions.map((d) => [d.Name, d.Value]));
  assert.equal(dims.WebACL, acl.Name);
  const authRule = acl.Rules.find((r) => r.Name === dims.Rule);
  assert.ok(authRule, `the alarm names rule "${dims.Rule}", which is not on the ACL`);
  assert.ok(authRule.Statement.RateBasedStatement, 'the alarmed rule is not the rate limiter');
});

test('violation reports reach the API rather than the bucket', () => {
  // The whole reason the report path is relative: a cross-origin collector
  // receives nothing, silently, and looks healthy while doing it. That only
  // works if this behaviour actually targets the API origin.
  const d = Object.values(wt.findResources('AWS::CloudFront::Distribution'))[0]
    .Properties.DistributionConfig;
  const behaviour = (d.CacheBehaviors || []).find((b) => b.PathPattern === '/csp-report');
  assert.ok(behaviour, 'no behaviour routes /csp-report');
  const target = d.Origins.find((o) => o.Id === behaviour.TargetOriginId);
  assert.equal(target.DomainName, 'api.test.example',
    'reports are being sent to the static bucket, which cannot collect them');
  assert.ok(behaviour.AllowedMethods.includes('POST'), 'a report is a POST');
  // The collector is unauthenticated by design and cannot use a session cookie.
  // Forwarding one hands a live credential to the one route that has no use for it.
  const policy = Object.values(wt.findResources('AWS::CloudFront::OriginRequestPolicy'))[0];
  assert.equal(policy.Properties.OriginRequestPolicyConfig.CookiesConfig.CookieBehavior, 'none');
});

test('the policy asks browsers of both generations to report', () => {
  const p = Object.values(wt.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0]
    .Properties.ResponseHeadersPolicyConfig;
  const csp = p.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
  // report-uri is what Firefox and Safari implement; report-to is what Chrome
  // implements. Emitting one collects from about half the browsers in use.
  assert.ok(csp.includes('report-uri /csp-report'), csp);
  assert.ok(csp.includes('report-to csp-endpoint'), csp);
  const reporting = p.CustomHeadersConfig.Items.find((h) => h.Header === 'Reporting-Endpoints');
  assert.ok(reporting, 'report-to names an endpoint that no header defines, so Chrome sends nothing');
  assert.equal(reporting.Value, 'csp-endpoint="/csp-report"');
});
