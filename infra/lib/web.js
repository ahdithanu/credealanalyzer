'use strict';

const { Stack, RemovalPolicy, Duration, CfnOutput } = require('aws-cdk-lib');
const s3 = require('aws-cdk-lib/aws-s3');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const certificatemanager = require('aws-cdk-lib/aws-certificatemanager');

/**
 * The SPA: a private S3 bucket behind CloudFront.
 *
 * The bucket is NOT a website endpoint and is not public. Origin Access Control
 * lets only this distribution read it, so there is no bucket URL that serves
 * the app while bypassing the security headers below.
 */
class WebStack extends Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);
    const { domainName, certificateArn, apiOrigin } = props;

    const bucket = new s3.Bucket(this, 'SpaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,      // a bad deploy is a rollback, not a rebuild
      removalPolicy: RemovalPolicy.RETAIN,
    });

    /**
     * Content Security Policy.
     *
     * This is the control that limits the damage of an XSS bug, and the session
     * design leans on it: the session cookie is httpOnly so script cannot read
     * it, but script could still ACT as the user inside the page. `connect-src`
     * naming only our own API is what stops injected script shipping a client
     * firm's pipeline to an attacker's host.
     *
     * No 'unsafe-inline' on script-src. Create React App emits a small inline
     * runtime chunk, so the build must be configured with INLINE_RUNTIME_CHUNK
     * =false or the app will not run under this policy — a real constraint,
     * noted here because the failure is a blank page with a console error.
     */
    const csp = [
      "default-src 'none'",
      "script-src 'self'",
      // Inline styles are permitted: the app styles a number of elements with
      // computed values (a stack bar's width from a share of total cost, for
      // instance). Removing this would mean a class per value.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      `connect-src 'self' ${apiOrigin || ''}`.trim(),
      "form-action 'self'",
      // No other site may frame the app, so a clickjacked overlay cannot
      // capture a click that approves a deal.
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; ');

    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          // Deny the browser features this app has no use for, so a compromised
          // page cannot reach for a camera or a location.
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
            override: true,
          },
        ],
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Spa', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: responseHeaders,
        // The app never sends a cookie or a query string to the SPA origin;
        // sessions live against the API. Caching everything else keeps the
        // static bundle at the edge.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      defaultRootObject: 'index.html',
      // Client-side routing: a deep link to /pipeline is not an object in the
      // bucket. 200, not 302, so the URL the analyst shared stays intact.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
      domainNames: domainName ? [domainName] : undefined,
      certificate: certificateArn
        ? certificatemanager.Certificate.fromCertificateArn(this, 'WebCert', certificateArn)
        : undefined,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      logIncludesCookies: false,
    });

    this.bucket = bucket;
    this.distribution = distribution;

    new CfnOutput(this, 'SpaUrl', { value: `https://${domainName || distribution.distributionDomainName}` });
    new CfnOutput(this, 'SpaBucketName', { value: bucket.bucketName });
  }
}

module.exports = { WebStack };
