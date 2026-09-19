#!/usr/bin/env node
'use strict';

const cdk = require('aws-cdk-lib');
const { PlatformStack } = require('../lib/platform');
const { WebStack } = require('../lib/web');

/**
 * Deployment entry point.
 *
 * Domains and certificates come from context so the same stacks deploy to a
 * staging account without editing code:
 *
 *   npx cdk deploy --all \
 *     -c apiDomain=api.cre.example.com  -c apiCertArn=arn:aws:acm:us-east-1:... \
 *     -c webDomain=app.cre.example.com  -c webCertArn=arn:aws:acm:us-east-1:... \
 *     -c alertEmail=ops@yourfirm.com
 *
 * `apiCertArn` is REQUIRED. Without a certificate the load balancer serves the
 * API over plaintext HTTP and its session cookies with it, so the platform
 * stack refuses to synthesize rather than offering a deployable insecure mode.
 * The web stack has no such requirement — CloudFront is HTTPS on its own
 * default hostname — but a real deployment wants both domains, because
 * config.js refuses to boot unless APP_ORIGIN is https and the SSO redirect URI
 * must match what the broker has registered.
 */
const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const apiDomain = app.node.tryGetContext('apiDomain');
const webDomain = app.node.tryGetContext('webDomain');
const apiCertArn = app.node.tryGetContext('apiCertArn');
const webCertArn = app.node.tryGetContext('webCertArn');
// Where alarms go. Optional, and its absence is NOT harmless: the alarms all
// deploy and all evaluate, and nobody is told when one fires. The SNS topic is
// created regardless, so a real destination — PagerDuty, Opsgenie, a Slack
// webhook via Chatbot — is a subscription on an existing topic rather than a
// change to this stack.
const alertEmail = app.node.tryGetContext('alertEmail');

/**
 * `production` (default) or `lean`.
 *
 * Lean removes the NAT gateways and the Multi-AZ database — roughly $250 a
 * month — by putting the API task in a public subnet behind its security group
 * and running one of it. See the note at the top of lib/platform.js for the
 * full list of what that gives up; nothing on it is a security control except
 * the task's subnet placement, and test/synth.test.js asserts that list so it
 * cannot quietly grow.
 */
const tier = app.node.tryGetContext('tier') || 'production';

const web = new WebStack(app, 'CreWeb', {
  env,
  domainName: webDomain,
  certificateArn: webCertArn,
  apiOrigin: apiDomain ? `https://${apiDomain}` : '',
});

const platform = new PlatformStack(app, 'CrePlatform', {
  env,
  domainName: apiDomain,
  certificateArn: apiCertArn,
  // The exact browser origin. The API's CORS check compares against this
  // string, and credentialed CORS cannot use a wildcard — so a mismatch shows
  // up as every request failing, not as a silent security hole.
  appOrigin: webDomain ? `https://${webDomain}` : 'http://localhost:3000',
  alertEmail,
  tier,
});

// Deliberately NOT ordered against each other. Web's connect-src names the
// API's domain and the API's CORS check names Web's origin, so they reference
// one another by CONFIGURATION, not by resource. Making that a stack dependency
// would invite exactly the cycle the security groups already demonstrated.
void platform; void web;

app.synth();
