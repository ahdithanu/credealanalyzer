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
const cloudwatch = require('aws-cdk-lib/aws-cloudwatch');
const cwActions = require('aws-cdk-lib/aws-cloudwatch-actions');
const sns = require('aws-cdk-lib/aws-sns');
const snsSubs = require('aws-cdk-lib/aws-sns-subscriptions');
const events = require('aws-cdk-lib/aws-events');
const eventTargets = require('aws-cdk-lib/aws-events-targets');

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
    const { domainName, certificateArn, appOrigin, alertEmail, tier = 'production' } = props;

    /**
     * TWO SHAPES OF THE SAME SYSTEM.
     *
     * `production` is the default and is what everything below was written for.
     * `lean` exists because roughly $250 a month of that is NAT gateways and a
     * Multi-AZ database, and a system nobody can afford to leave running is not
     * more secure than one that is deployed — it is just not deployed.
     *
     * WHAT LEAN DOES NOT GIVE UP, because this is where a cost tier usually
     * turns into a security tier by accident:
     *
     *   - row level security, and the two-role privilege split
     *   - envelope encryption of deal payloads, and per-tenant keys
     *   - the WAF, all five rules
     *   - IAM database authentication; still no password in the task
     *   - every alarm, the audit chain, and its daily verification
     *   - TLS-only, deletion protection, RETAIN on the database
     *   - AND the egress-less data subnet: the database still has no route to
     *     anywhere, which is the claim the security register actually makes
     *
     * WHAT IT GIVES UP, stated plainly and asserted in test/synth.test.js so
     * the list cannot quietly grow:
     *
     *   1. The API task runs in a PUBLIC subnet with a public IP, because that
     *      is what removes the NAT gateway. It is not reachable from the
     *      internet — its security group admits the load balancer and nothing
     *      else — but it is protected by a security group rather than by having
     *      no route. That is a weaker position and a real one.
     *   2. Single-AZ database. A failover becomes a restore: minutes, not
     *      seconds, and the RPO is whatever the last backup holds.
     *   3. One task. A deploy is a brief interruption and a crash is an outage
     *      until ECS replaces it.
     *   4. Smaller instance and 7-day backups instead of 30.
     *
     * If a client firm's data is going in it, deploy `production`. Lean is for
     * a demonstration, a staging environment, or a first customer who knows.
     */
    const lean = tier === 'lean';
    if (!['production', 'lean'].includes(tier)) {
      throw new Error(`tier must be "production" or "lean"; got ${JSON.stringify(tier)}`);
    }
    this.tier = tier;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      // Production: two NATs, one per AZ. A single NAT is cheaper and is a
      // single point of failure for every outbound call the API makes —
      // including the SSO token exchange and the Duo handshake, which means one
      // AZ's NAT dying logs out every firm.
      //
      // Lean: none at all. The NAT gateways are the single largest line on the
      // bill and the task reaches the internet directly from a public subnet
      // instead. There is no middle option here with one NAT, because one NAT
      // is the worst of both: it still costs, and it is still a single point of
      // failure for every login.
      natGateways: lean ? 0 : 2,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // A PRIVATE_WITH_EGRESS subnet with no NAT to egress through is not a
        // thing, so lean does not declare one; the task moves to `public`.
        ...(lean ? [] : [
          { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        ]),
        // No egress, in BOTH tiers. The database cannot initiate a connection
        // to anywhere.
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    /** Where the API task runs, and whether it needs an address of its own. */
    const taskPlacement = lean
      ? { subnetType: ec2.SubnetType.PUBLIC }
      : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

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
      multiAz: !lean,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G,
        lean ? ec2.InstanceSize.MICRO : ec2.InstanceSize.MEDIUM),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      allocatedStorage: lean ? 20 : 100,
      maxAllocatedStorage: lean ? 100 : 500,
      storageEncrypted: true,
      // IAM database authentication. This is why no database password exists in
      // the task definition, the image, or Secrets Manager for the app roles:
      // the task exchanges its IAM identity for a token that lives 15 minutes.
      // A leaked environment dump contains no usable database credential.
      iamAuthentication: true,
      // The master credential still exists — migrations and role management
      // need it — and is generated and rotated by Secrets Manager, never typed.
      credentials: rds.Credentials.fromGeneratedSecret('cre_owner'),
      // Still measured in weeks, not days: the backup is the only recovery
      // a single-AZ instance has.
      backupRetention: Duration.days(lean ? 7 : 30),
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

    /**
     * The key that seals every tenant's Duo client secret.
     *
     * Generated here and never typed, like the session signing secret — but a
     * SEPARATE secret from it, which is the whole point. A key used to sign and
     * a key used to encrypt must be rotatable independently, or the rotation
     * runbook for one silently invalidates the other and nobody finds out until
     * a firm's logins start failing.
     *
     * 32 bytes, base64, which is what mfa.duoKey() expects. RETAIN on delete:
     * losing this key does not lose a session, it loses the ability to open
     * every Duo client secret on the platform, and re-provisioning those means
     * asking every customer for a credential from their own Duo console.
     */
    const duoKeySecret = new secretsmanager.Secret(this, 'DuoConfigKey', {
      description: 'DUO_CONFIG_KEY — seals per-tenant Duo client secrets (AES-256-GCM)',
      generateSecretString: {
        /**
         * 43 characters, not 44, and the difference is a production outage.
         *
         * The alphabet is constrained to [A-Za-z0-9] because the value has to
         * survive base64 decoding and the generator's punctuation set does not.
         * With no padding, base64 length maps to bytes in steps: 42 chars decode
         * to 31 bytes, 43 to 32, 44 to 33. Only 43 gives AES-256 its key.
         *
         * 44 was the obvious-looking number — it is what 32 bytes encodes TO,
         * with a pad character this alphabet cannot contain — and it would have
         * synthesized, deployed, and thrown `DUO_CONFIG_KEY must decode to 32
         * bytes; got 33` at the first Duo login on a customer's first day.
         * Asserted in test/synth.test.js against a real decode.
         */
        passwordLength: 43,
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/^-_=,.@"\\',
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
    duoKeySecret.grantRead(taskRole);

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

    const apiLogs = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_YEAR,
      // A `cdk destroy` must not take the evidence with it.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: lean ? 1 : 2,
      publicLoadBalancer: true,
      // The tasks themselves are NOT public. Only the load balancer is.
      taskSubnets: taskPlacement,
      // Only in lean, and only because there is no NAT: the task needs a route
      // to the internet for the SSO token exchange and the Duo handshake. Its
      // security group still admits the load balancer and nothing else, so a
      // public address is not a public service.
      assignPublicIp: lean,
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
          // Where Duo returns the browser. Must match the redirect registered
          // on each customer's Duo application EXACTLY — Duo compares it on
          // both the authorize call and the token exchange, so a mismatch is a
          // login that fails at the last step with an opaque error.
          DUO_REDIRECT_URI: `https://${domainName || 'api.example'}/auth/duo/callback`,
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
          DUO_CONFIG_KEY: ecs.Secret.fromSecretsManager(duoKeySecret, 'value'),
        },
        // The log group is created HERE rather than left to the log driver,
        // and that is what makes the security alarms below possible: a metric
        // filter has to be attached to a LogGroup construct, and the group the
        // driver creates for itself is not one this stack holds a reference to.
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'api', logGroup: apiLogs }),
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

    service.service.autoScaleTaskCount({ minCapacity: lean ? 1 : 2, maxCapacity: lean ? 4 : 10 })
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
    /**
     * The ACL's name and its CloudWatch metric name are deliberately THE SAME
     * STRING, and so is every rule's, which looks redundant and is not.
     *
     * The WafAuthBlockedAlarm below has to name a `WebACL` and a `Rule`
     * dimension. AWS's documentation for WAFv2 describes those dimension values
     * as the metric names from each VisibilityConfig; a good deal of
     * documentation and example code elsewhere treats them as the resource
     * names. Getting it wrong does not fail to deploy and does not fail to
     * synth — it produces an alarm that matches no metric and therefore never
     * leaves INSUFFICIENT_DATA, which on a console full of grey alarms is
     * indistinguishable from quiet. Making the two strings identical means the
     * alarm binds under either reading, and removes a question that otherwise
     * could not be settled without deploying and waiting for an attack.
     *
     * The name is derived from the stack name rather than hardcoded so two
     * deployments in one account and region do not collide on it.
     */
    const aclName = `${this.stackName}-api-acl`;

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: aclName,
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true, metricName: aclName, sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp', sampledRequestsEnabled: true,
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
            cloudWatchMetricsEnabled: true, metricName: 'RateLimitAuth', sampledRequestsEnabled: true,
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
            cloudWatchMetricsEnabled: true, metricName: 'AWSManagedCommon', sampledRequestsEnabled: true,
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
            cloudWatchMetricsEnabled: true, metricName: 'AWSManagedBadInputs', sampledRequestsEnabled: true,
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
            cloudWatchMetricsEnabled: true, metricName: 'AWSManagedSqli', sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'WebAclAssoc', {
      resourceArn: service.loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // ─── Alerting ────────────────────────────────────────────────────────────
    /**
     * Where an alarm goes.
     *
     * An email subscription is the default because it needs no third-party
     * account to demonstrate, and it is stated plainly as inadequate for
     * anything real: email is not paging, nobody is woken by it, and an alarm
     * that fires at 02:00 into an inbox is discovered at 09:00. Point this topic
     * at PagerDuty or Opsgenie before a client firm's data is behind it. The
     * topic exists either way so that wiring a real destination is a
     * subscription, not a refactor.
     */
    const alarmTopic = new sns.Topic(this, 'Alerts', {
      displayName: 'CRE Analyzer alarms',
      // Enforced by policy rather than by hope: an SNS topic that accepts
      // unencrypted publishes over HTTP is a channel carrying tenant ids and
      // failure detail in the clear.
      enforceSSL: true,
    });
    if (alertEmail) {
      alarmTopic.addSubscription(new snsSubs.EmailSubscription(alertEmail));
    }

    const alarmAction = new cwActions.SnsAction(alarmTopic);

    /**
     * Every alarm in this stack goes through here, and every one of them gets
     * BOTH an alarm action and an OK action.
     *
     * The OK action is the part that is easy to leave out and expensive to have
     * left out: without it, an alarm that fires and then recovers is never
     * mentioned again, so the on-call's mental model is "we had an incident"
     * when the truth is "we had a blip". Teams learn to ignore alarms they are
     * never told the end of.
     *
     * `treatMissingData` is passed explicitly at every call site rather than
     * defaulted, because the right answer genuinely differs: for a security
     * COUNT, no data means no attacks and is good news; for a health metric, no
     * data means the thing being measured has stopped reporting and is usually
     * worse news than a breach of the threshold.
     */
    const alarms = [];
    const alarm = (id, props) => {
      const a = new cloudwatch.Alarm(this, id, {
        ...props,
        alarmDescription: props.alarmDescription,
      });
      a.addAlarmAction(alarmAction);
      a.addOkAction(alarmAction);
      alarms.push(a);
      return a;
    };

    // ─── Security signals, from the application's own log ────────────────────
    /**
     * These are metric filters over the API's log group, matching the events
     * that server/src/obs/securityLog.js emits.
     *
     * The filters and the emitter are a CONTRACT, and a brittle one: a filter
     * matches a literal field name, so renaming `kind` or a kind's value in the
     * server turns every alarm below into decoration. It does not break. It
     * simply never fires again, and nobody finds out until the incident it was
     * meant to catch. Both sides are asserted — server/test/observability.test.js
     * pins the emitted names, infra/test/synth.test.js pins these filters — so
     * changing one without the other turns a suite red.
     *
     * Writing these is also what revealed that the application logged almost
     * nothing a filter could match: refusals were correct and silent. The
     * emitter exists because of these alarms, not the other way round.
     */
    const securityFilter = (kind) => logs.FilterPattern.all(
      logs.FilterPattern.stringValue('$.evt', '=', 'security'),
      logs.FilterPattern.stringValue('$.kind', '=', kind),
    );

    const NS = 'CreAnalyzer/Security';
    const securityMetric = (id, kind, metricName) => {
      new logs.MetricFilter(this, id, {
        logGroup: apiLogs,
        filterPattern: securityFilter(kind),
        metricNamespace: NS,
        metricName,
        metricValue: '1',
        // Explicit zero, and this matters more than it looks: without it the
        // metric has NO datapoint in a quiet period, and an alarm on it sits in
        // INSUFFICIENT_DATA rather than OK. An operator glancing at a console
        // full of grey alarms cannot tell "quiet" from "broken".
        defaultValue: 0,
      });
      return new cloudwatch.Metric({
        namespace: NS, metricName, statistic: 'Sum', period: Duration.minutes(5),
      });
    };

    const csrfRejected = securityMetric('CsrfFilter', 'csrf_rejected', 'CsrfRejected');
    const originRejected = securityMetric('OriginFilter', 'origin_rejected', 'OriginRejected');
    const loginFailed = securityMetric('LoginFailedFilter', 'login_failed', 'LoginFailed');
    const scimAuthFailed = securityMetric('ScimAuthFilter', 'scim_auth_failed', 'ScimAuthFailed');
    const roleDenied = securityMetric('RoleDeniedFilter', 'role_denied', 'RoleDenied');
    const rateLimited = securityMetric('RateLimitedFilter', 'rate_limited', 'RateLimited');
    const mfaFailed = securityMetric('MfaFailedFilter', 'mfa_failed', 'MfaFailed');
    const mfaFailopen = securityMetric('MfaFailopenFilter', 'mfa_failopen', 'MfaFailopen');
    const cspViolation = securityMetric('CspFilter', 'csp_violation', 'CspViolation');
    const serverError = securityMetric('ServerErrorFilter', 'server_error', 'ServerError');
    const auditBroken = securityMetric('AuditChainFilter', 'audit_chain_broken', 'AuditChainBroken');

    /**
     * THE THRESHOLDS BELOW ARE STARTING VALUES, NOT MEASURED ONES.
     *
     * Nothing has been deployed and no real traffic has ever passed through
     * this system, so every number here is reasoned from what the event means
     * rather than from a baseline. Two of them are safe regardless — a broken
     * audit chain and a failed SCIM authentication should be zero forever — and
     * the rest will need tuning in the first fortnight of real use. Saying so
     * here is better than the alternative, which is an operator assuming these
     * were derived from data and trusting a number that was a guess.
     */

    // A single broken link in the audit chain. There is no acceptable rate.
    alarm('AuditChainBrokenAlarm', {
      metric: auditBroken.with({ period: Duration.hours(1) }),
      threshold: 0, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'The audit log hash chain failed verification: an entry was altered, deleted or '
        + 'inserted around the trigger. P1. See docs/runbooks/incident-response.md.',
    });

    /**
     * The audit verification job STOPPED RUNNING.
     *
     * Distinct from the alarm above and arguably more important. A chain that is
     * never verified raises no alarm at all, so the failure mode of the daily
     * task quietly dying is indistinguishable from a healthy system — right up
     * until someone needs the evidence and finds the last proof of integrity is
     * from before the breach.
     *
     * Matches the healthy line the job writes, and fires on its ABSENCE, which
     * is why treatMissingData is BREACHING here and NOT_BREACHING everywhere
     * else on this page.
     */
    new logs.MetricFilter(this, 'AuditVerifyRanFilter', {
      logGroup: apiLogs,
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.evt', '=', 'audit_verify'),
        logs.FilterPattern.stringValue('$.result', '=', 'intact'),
      ),
      metricNamespace: NS, metricName: 'AuditVerifyRan', metricValue: '1',
    });
    alarm('AuditVerifyStalledAlarm', {
      metric: new cloudwatch.Metric({
        namespace: NS, metricName: 'AuditVerifyRan',
        statistic: 'Sum', period: Duration.hours(26),
      }),
      threshold: 1, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      // No datapoint IS the failure being watched for. Note the deliberate
      // absence of defaultValue on the filter above: a zero every period would
      // satisfy "has a datapoint" and defeat the whole alarm.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription:
        'The daily audit-chain verification has not reported an intact log in 26 hours. '
        + 'The integrity control is not running; the chain is unverified, not proven broken.',
    });

    /**
     * A session was issued WITHOUT the second factor its tenant requires.
     *
     * Threshold zero, like the audit chain, and for the same reason: this is
     * not a rate to tune, it is a control that was not applied. It happens only
     * when Duo was unreachable AND the tenant is configured to admit on
     * failure, so every occurrence is a login that a customer believes was
     * protected by a second factor and was not. They are entitled to know, and
     * the audit entry tells them; this tells us first.
     */
    alarm('MfaFailopenAlarm', {
      metric: mfaFailopen.with({ period: Duration.minutes(5) }),
      threshold: 0, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Users were admitted without the second factor their firm requires, because Duo was '
        + 'unreachable and that tenant fails open. Check Duo, then check who got in.',
    });

    /**
     * Second factors that were asked for and did not pass.
     *
     * A handful is ordinary: people decline a push, or walk away from a prompt.
     * Volume is not, and the `code` field is what separates the two — a run of
     * `username_mismatch` in particular is someone attempting to bind their own
     * Duo success to another person's pending login, which is the specific
     * attack the exchange in auth/duo.js is written to refuse.
     */
    alarm('MfaFailedAlarm', {
      metric: mfaFailed,
      threshold: 15, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Unusual volume of failed second factors. Read `code`: username_mismatch is an attempt '
        + 'to bind one person\'s Duo result to another\'s login; unreachable is a Duo outage.',
    });

    // A SCIM token is a standing credential that can enumerate and deactivate
    // every user in a tenant. Nothing legitimate fails to authenticate with one.
    alarm('ScimAuthFailedAlarm', {
      metric: scimAuthFailed,
      threshold: 3, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Repeated failed authentication against a SCIM provisioning token. Either a '
        + 'directory is misconfigured or someone is probing the highest-privilege '
        + 'standing credential in the system.',
    });

    // A browser holding a valid session was handed a CSRF token with it. A
    // request with the first and not the second is a forgery attempt or a
    // client broken enough to be worth knowing about. A handful an hour is a
    // stale tab; twenty in five minutes is not.
    alarm('CsrfRejectedAlarm', {
      metric: csrfRejected,
      threshold: 20, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Unusual volume of rejected CSRF tokens: possible cross-site request forgery.',
    });

    // A state-changing request from a site that is not the app. The legitimate
    // app never produces one, so the threshold is low on purpose.
    alarm('OriginRejectedAlarm', {
      metric: originRejected,
      threshold: 5, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'State-changing requests arriving from an origin that is not the app. The rejected '
        + 'origin is in the log line and names the site attempting it.',
    });

    /**
     * Refused logins. TWO evaluation periods, not one.
     *
     * This is the noisiest security metric in the system — an expired browser
     * tab, a firm rolling out a new IdP connection, one analyst with a typo in
     * their directory — and a single-period alarm on it would be the one people
     * learn to dismiss, which is how the alarm that matters gets dismissed with
     * it. Ten minutes of sustained failure is a signal; five is a Monday.
     *
     * The log line carries the failure CODE, which is the part an operator
     * actually acts on: `domain_not_verified` in volume is a connection pointed
     * at the wrong organization, `bad_state` in volume is replay.
     */
    alarm('LoginFailedAlarm', {
      metric: loginFailed,
      threshold: 25, evaluationPeriods: 2, datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Sustained SSO login failures. Check the `code` field: domain_not_verified in volume '
        + 'means an SSO connection is pointed at the wrong organization; bad_state means replay.',
    });

    // An authenticated user reaching repeatedly for things their role does not
    // cover. One is a mis-click. A stream from one user id is someone mapping
    // the edges of their permissions.
    alarm('RoleDeniedAlarm', {
      metric: roleDenied,
      threshold: 15, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'An authenticated user is repeatedly attempting actions their role does not permit. '
        + 'The user and tenant ids are in the log line.',
    });

    /**
     * CSP violations.
     *
     * The most direct evidence available that someone is attempting script
     * injection against an analyst's browser. Also the metric most likely to
     * fire for a boring reason — a browser extension injecting into the page
     * produces violations that are nothing to do with us — so the threshold is
     * set for volume rather than presence, and the first job on an alarm is to
     * read `blockedURI` and decide which of the two it is.
     */
    alarm('CspViolationAlarm', {
      metric: cspViolation,
      threshold: 10, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Content-Security-Policy violations are being reported. Read blockedURI: an external '
        + 'host means attempted injection or exfiltration; a browser-extension URL is noise.',
    });

    // Sustained rate limiting. The in-process limiter is approximate and the
    // WAF does the precise counting, so this is a shape signal rather than a
    // count: a lot of it means someone is pushing.
    alarm('RateLimitedAlarm', {
      metric: rateLimited,
      threshold: 50, evaluationPeriods: 2, datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Sustained rate limiting. The `limiter` field names which ceiling is being hit.',
    });

    // ─── Availability ────────────────────────────────────────────────────────

    alarm('ServerErrorAlarm', {
      metric: serverError,
      threshold: 10, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The API is returning 5xx to clients.',
    });

    alarm('Alb5xxAlarm', {
      // The load balancer's OWN 5xx, not the target's. This is the one that
      // fires when no healthy target exists at all — the case where the
      // application-level 5xx metric above sees nothing precisely because
      // nothing is running to log it.
      metric: service.loadBalancer.metrics.httpCodeElb(
        elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: Duration.minutes(5) },
      ),
      threshold: 5, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The load balancer itself is returning 5xx — often no healthy target.',
    });

    alarm('UnhealthyHostsAlarm', {
      metric: service.targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1) }),
      threshold: 0, evaluationPeriods: 3, datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      // Missing data here means the target group is not reporting, which is not
      // the same as healthy and should not be silently treated as such.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'An API task is failing its health check. Below two healthy tasks there is no redundancy.',
    });

    alarm('LatencyAlarm', {
      // p99, not average. An average hides the case this is for: most requests
      // fast and a tail of underwriting saves timing out, which is the shape a
      // database problem or a pool exhaustion actually produces.
      metric: service.targetGroup.metrics.targetResponseTime({
        period: Duration.minutes(5), statistic: 'p99',
      }),
      threshold: 3, evaluationPeriods: 2, datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'p99 API latency above three seconds. An IC meeting is waiting on this.',
    });

    // ─── The database ────────────────────────────────────────────────────────

    alarm('DbCpuAlarm', {
      metric: this.database.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 80, evaluationPeriods: 3, datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'Sustained high database CPU.',
    });

    alarm('DbStorageAlarm', {
      metric: this.database.metricFreeStorageSpace({ period: Duration.minutes(5) }),
      // 10 GiB. Storage autoscales to 500 GiB, so this should never fire — and
      // if it does, autoscaling has failed and the window before writes start
      // failing is measured in hours, not days.
      threshold: 10 * 1024 * 1024 * 1024, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'Database free storage below 10 GiB despite autoscaling. Writes fail when it reaches zero.',
    });

    alarm('DbConnectionsAlarm', {
      metric: this.database.metricDatabaseConnections({ period: Duration.minutes(5) }),
      // Ten per task across up to ten tasks, plus headroom for migrations and
      // the scheduled verification job. Approaching the instance's ceiling means
      // a new task cannot get a connection and the deploy stalls.
      threshold: 120, evaluationPeriods: 2, datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Database connection count approaching the instance ceiling.',
    });

    alarm('DbMemoryAlarm', {
      metric: this.database.metricFreeableMemory({ period: Duration.minutes(5) }),
      threshold: 256 * 1024 * 1024, evaluationPeriods: 3, datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'Database freeable memory below 256 MiB: the working set no longer fits.',
    });

    // ─── The WAF ─────────────────────────────────────────────────────────────
    /**
     * Blocked requests on the auth path specifically.
     *
     * The WAF blocking traffic is the system working, so this is not an
     * availability alarm — it is a "someone is trying" alarm. The auth rule is
     * the one worth watching: /auth/ is the only unauthenticated endpoint that
     * touches the database, and volume there is either a brute-force attempt
     * against session tokens or an attempt to fill sso_states.
     */
    alarm('WafAuthBlockedAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        dimensionsMap: {
          WebACL: aclName, Rule: 'RateLimitAuth', Region: this.region,
        },
        statistic: 'Sum', period: Duration.minutes(5),
      }),
      threshold: 100, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'The WAF is blocking sustained traffic to /auth/. The control is working; someone is '
        + 'pushing against it.',
    });

    // ─── The scheduled audit verification ────────────────────────────────────
    /**
     * Runs the hash-chain verification daily, on the SAME task definition and
     * image as the API — so it holds the same IAM database identity, connects
     * as the same non-owner role, and cannot drift away from the application it
     * is verifying. A separate image would be a second thing to build, patch
     * and get wrong.
     *
     * 03:17 UTC rather than the top of an hour: nothing else in this account
     * runs then, and a job sharing a minute with every other cron in AWS is a
     * job that competes for capacity for no reason.
     */
    new events.Rule(this, 'AuditVerifySchedule', {
      schedule: events.Schedule.cron({ minute: '17', hour: '3' }),
      description: 'Daily verification of the audit log hash chain',
      targets: [new eventTargets.EcsTask({
        cluster,
        taskDefinition: service.taskDefinition,
        subnetSelection: taskPlacement,
        assignPublicIp: lean,
        securityGroups: [this.appSecurityGroup],
        containerOverrides: [{
          containerName: service.taskDefinition.defaultContainer.containerName,
          command: ['node', 'src/admin/verifyAudit.js'],
        }],
        // One attempt. A retry on a broken chain would write the alarm-bearing
        // line three times and treble the apparent severity of one event.
        retryAttempts: 0,
      })],
    });

    this.alarmTopic = alarmTopic;
    this.apiLogs = apiLogs;
    this.alarms = alarms;

    this.service = service;
    this.ssoSecret = ssoSecret;
    this.duoKeySecret = duoKeySecret;

    new CfnOutput(this, 'ApiUrl', { value: `https://${domainName || service.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, 'DbEndpoint', { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, 'SsoSecretName', { value: ssoSecret.secretName });
    new CfnOutput(this, 'DuoRedirectUri', {
      value: `https://${domainName || service.loadBalancer.loadBalancerDnsName}/auth/duo/callback`,
      description: 'Register this exact URL on every customer Duo application',
    });
    new CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
    new CfnOutput(this, 'ApiLogGroup', { value: apiLogs.logGroupName });
  }
}

module.exports = { PlatformStack };
