'use strict';

const { Stack, Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecsPatterns = require('aws-cdk-lib/aws-ecs-patterns');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const rds = require('aws-cdk-lib/aws-rds');
const iam = require('aws-cdk-lib/aws-iam');
const logs = require('aws-cdk-lib/aws-logs');
const wafv2 = require('aws-cdk-lib/aws-wafv2');
const secretsmanager = require('aws-cdk-lib/aws-secretsmanager');
const certificatemanager = require('aws-cdk-lib/aws-certificatemanager');

/**
 * The platform: network, database and API in ONE stack.
 *
 * They were three stacks first, and that does not work here. Security groups
 * are the reason, and it is worth recording because the instinct to split by
 * concern is otherwise a good one. A load balancer needs an ingress rule on the
 * service's group; the service needs one on the database's group. Put the VPC
 * in one stack and its consumers in another and CloudFormation ends up with
 * each stack referencing a group ID in the other, which `cdk synth` rejects as
 * a dependency cycle — and it rejects it whichever side owns which group, so
 * moving the groups around only moves the cycle.
 *
 * The web stack stays separate because it genuinely is: CloudFront and S3 share
 * no VPC resource with any of this, and reference the API only by hostname.
 *
 * The shape here is driven by one requirement: client firms' deal data must not
 * be reachable from the internet, and must not be reachable even if the API is
 * compromised in a way that lets an attacker open outbound connections. So the
 * database sits in isolated subnets with NO route to a NAT gateway at all —
 * not merely private, but egress-less. An attacker who lands in the API task
 * can still reach the database (that is the API's job) but cannot exfiltrate
 * from the database's subnet to a host of their own.
 */
class PlatformStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { domainName, certificateArn, appOrigin } = props;


    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      // Two NATs, one per AZ. A single NAT is cheaper and is a single point of
      // failure for every outbound call the API makes — including the SSO token
      // exchange, which means one AZ's NAT dying logs out every firm.
      natGateways: 2,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        // No egress. The database cannot initiate a connection to anywhere.
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // VPC flow logs. When a client firm asks "can you prove nothing left your
    // network", an answer without packet-level records is an opinion.
    this.vpc.addFlowLog('FlowLog', {
      trafficType: ec2.FlowLogTrafficType.ALL,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogs', {
          retention: logs.RetentionDays.ONE_YEAR,
          removalPolicy: RemovalPolicy.RETAIN,
        }),
      ),
    });

    // The API's security group is created HERE, not in the API stack, and this
    // is not a stylistic choice: if the API stack adds an ingress rule to the
    // database's security group, CloudFormation ends up with CreNetwork
    // depending on CreApi (for the rule) while CreApi depends on CreNetwork
    // (for the VPC), and `cdk synth` fails outright with a dependency cycle.
    // Owning both groups on this side keeps the dependency one-way.
    this.appSecurityGroup = new ec2.SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      description: 'API tasks. Egress open for the SSO token exchange and AWS APIs.',
      allowAllOutbound: true,
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      description: 'Postgres. Ingress only from the API service security group.',
      // No egress rules at all: nothing legitimate originates at the database.
      allowAllOutbound: false,
    });

    // Only the API tasks may reach Postgres, and only on 5432. Declared here so
    // the rule lives in the same stack as both groups it references.
    this.dbSecurityGroup.addIngressRule(
      this.appSecurityGroup,
      ec2.Port.tcp(5432),
      'API tasks to Postgres',
    );

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      // Multi-AZ: a failover is a few seconds of errors rather than a restore
      // from backup, which for a tool an IC meeting depends on is the
      // difference between an inconvenience and a missed committee.
      multiAz: true,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      storageEncrypted: true,
      // IAM database authentication. This is why no database password exists in
      // the task definition, the image, or Secrets Manager for the app roles:
      // the task exchanges its IAM identity for a token that lives 15 minutes.
      // A leaked environment dump contains no usable database credential.
      iamAuthentication: true,
      // The master credential still exists — migrations and role management
      // need it — and is generated and rotated by Secrets Manager, never typed.
      credentials: rds.Credentials.fromGeneratedSecret('cre_owner'),
      backupRetention: Duration.days(30),
      deletionProtection: true,
      // Retained on stack deletion: a `cdk destroy` that silently drops client
      // firms' deal history is not an acceptable failure mode.
      removalPolicy: RemovalPolicy.RETAIN,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_YEAR,
      // Applied automatically in the maintenance window. A Postgres security
      // patch is not something to schedule a meeting about.
      autoMinorVersionUpgrade: true,
      parameters: {
        // Log every statement that modifies data, for the audit story. Not
        // `all`: logging SELECTs on a deal table writes the deal data into
        // CloudWatch, which moves the confidentiality problem rather than
        // solving it.
        log_statement: 'mod',
        // Catch a runaway query in the logs as well as in the app's own
        // statement_timeout.
        log_min_duration_statement: '3000',
        'rds.force_ssl': '1',
      },
    });


    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Broker credentials and the session signing key. These DO live in Secrets
    // Manager, unlike the database credential, because they are shared secrets
    // with a third party and with ourselves — there is no IAM equivalent.
    const ssoSecret = new secretsmanager.Secret(this, 'SsoSecret', {
      description: 'WORKOS_API_KEY, WORKOS_CLIENT_ID',
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      description: 'SESSION_SIGNING_SECRET for cookie and CSRF derivation',
      generateSecretString: {
        // 64 bytes. config.js refuses to boot under 32.
        passwordLength: 64,
        excludePunctuation: true,
        generateStringKey: 'value',
        secretStringTemplate: JSON.stringify({}),
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'The API task. Holds IAM database auth for two Postgres roles and nothing else.',
    });

    // IAM database authentication, granted per DATABASE ROLE. This is the
    // privilege split from migration 002 expressed in IAM as well as in
    // Postgres: two resource ARNs, each naming one role. Neither grant implies
    // the other, and neither implies the owner — so a compromised task cannot
    // connect as the table owner and bypass row level security.
    const dbResourceBase =
      `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${this.database.instanceResourceId}`;
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [`${dbResourceBase}/app_user`, `${dbResourceBase}/auth_user`],
    }));

    ssoSecret.grantRead(taskRole);
    sessionSecret.grantRead(taskRole);

    // A certificate is REQUIRED, and this refusal is deliberate.
    //
    // Without one the ALB pattern falls back to an HTTP listener, and the stack
    // synthesizes and deploys perfectly happily — serving an API whose entire
    // authentication model is a session cookie over plaintext. The convenience
    // of a "first look without a domain" is not worth a deployable
    // configuration that leaks every session on the wire, and the failure would
    // be invisible: everything works, and works insecurely.
    //
    // Caught by test/synth.test.js, which asserted every listener is HTTPS and
    // failed against the no-certificate case.
    if (!certificateArn) {
      throw new Error(
        'certificateArn is required: without it the load balancer serves the API over plaintext '
        + 'HTTP, and its session cookies with it. Pass -c apiCertArn=arn:aws:acm:...',
      );
    }
    const certificate = certificatemanager.Certificate.fromCertificateArn(
      this, 'Cert', certificateArn,
    );

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 2,
      publicLoadBalancer: true,
      // The tasks themselves are NOT public. Only the load balancer is.
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Created in the network stack; see the note there on the dependency
      // cycle that arises from doing it the other way round.
      securityGroups: [this.appSecurityGroup],
      certificate,
      // `domainName` is deliberately NOT passed to this pattern. Given one, it
      // tries to create a Route53 alias record and demands a hosted zone —
      // which assumes CDK owns the DNS for the domain. It should not: the zone
      // for a firm-facing hostname often lives in a different account, or with
      // a registrar, and a deploy that fails because it cannot write a record
      // it was never meant to write is a bad first experience. Point a CNAME or
      // an alias at the load balancer output yourself.
      //
      // Terminate TLS at the ALB and refuse plaintext outright. A redirect from
      // http is friendlier for a browser typing a URL; for an API it would mean
      // the first request carrying a session cookie went out in the clear.
      redirectHTTP: false,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS13,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset('../server'),
        containerPort: 8080,
        environment: {
          NODE_ENV: 'production',
          PORT: '8080',
          APP_ORIGIN: appOrigin,
          SSO_PROVIDER: 'workos',
          WORKOS_REDIRECT_URI: `https://${domainName || 'api.example'}/auth/callback`,
          DB_HOST: this.database.dbInstanceEndpointAddress,
          DB_PORT: this.database.dbInstanceEndpointPort,
          DB_NAME: 'cre',
          // The entrypoint mints an IAM auth token per connection and assembles
          // DATABASE_URL / AUTH_DATABASE_URL from these. No password anywhere.
          DB_APP_USER: 'app_user',
          DB_AUTH_USER: 'auth_user',
        },
        secrets: {
          WORKOS_API_KEY: ecs.Secret.fromSecretsManager(ssoSecret, 'WORKOS_API_KEY'),
          WORKOS_CLIENT_ID: ecs.Secret.fromSecretsManager(ssoSecret, 'WORKOS_CLIENT_ID'),
          SESSION_SIGNING_SECRET: ecs.Secret.fromSecretsManager(sessionSecret, 'value'),
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'api',
          logRetention: logs.RetentionDays.ONE_YEAR,
        }),
        taskRole,
      },
      healthCheckGracePeriod: Duration.seconds(60),
      circuitBreaker: { rollback: true },
    });

    // /healthz, not /. The default target-group check hits `/`, which this API
    // answers with a 404 — the service would never come into service and the
    // deployment would roll back with a healthy container.
    service.targetGroup.configureHealthCheck({
      path: '/healthz',
      healthyHttpCodes: '200',
      interval: Duration.seconds(15),
      timeout: Duration.seconds(5),
    });
    // Long enough to finish an in-flight underwriting save, short enough that a
    // deploy is not slow. server/src/index.js drains on SIGTERM.
    service.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '20');

    service.service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 10 })
      .scaleOnCpuUtilization('Cpu', {
        targetUtilizationPercent: 60,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(1),
      });

    // ─── WAF ─────────────────────────────────────────────────────────────────
    // Rate limiting is the rule that matters most here. SSO login is the one
    // unauthenticated, database-touching endpoint, and without a limit it is
    // both a brute-force surface against session tokens and a cheap way to fill
    // the sso_states table.
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true, metricName: 'creApiAcl', sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true, metricName: 'rateLimit', sampledRequestsEnabled: true,
          },
        },
        {
          // Tighter still on the auth path.
          name: 'RateLimitAuth',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 100,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/auth/',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true, metricName: 'rateLimitAuth', sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedCommon',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true, metricName: 'common', sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedBadInputs',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true, metricName: 'badInputs', sampledRequestsEnabled: true,
          },
        },
        {
          // SQL injection rules, even though every query in the server is
          // parameterised. Defence in depth is the point: the day someone adds
          // a query that is not, this is already in front of it.
          name: 'AWSManagedSqli',
          priority: 4,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesSQLiRuleSet' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true, metricName: 'sqli', sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'WebAclAssoc', {
      resourceArn: service.loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    this.service = service;
    this.ssoSecret = ssoSecret;

    new CfnOutput(this, 'ApiUrl', { value: `https://${domainName || service.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, 'DbEndpoint', { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, 'SsoSecretName', { value: ssoSecret.secretName });
  }
}

module.exports = { PlatformStack };
