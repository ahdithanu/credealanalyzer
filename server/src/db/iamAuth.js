'use strict';

/**
 * RDS IAM database authentication.
 *
 * This is what makes the claim "no long-lived database credential exists"
 * actually true rather than aspirational. The task exchanges its IAM role for a
 * token that is valid for 15 minutes; a leaked environment dump, a debug
 * endpoint, or a stolen image contains nothing that opens the database
 * tomorrow.
 *
 * The 15-minute lifetime is the part that needs care. A connection POOL holds
 * connections for hours, so a token minted at startup would authenticate the
 * first connections and then quietly fail as the pool grows or recycles — an
 * outage twenty minutes after a deploy, which is the worst kind because the
 * deploy looked fine. node-postgres accepts `password` as a FUNCTION and calls
 * it per connection attempt, so each new connection gets a fresh token.
 */

let Signer = null;

/** Lazy, and optional: local development and the test suite never load the SDK. */
function loadSigner() {
  if (Signer !== null) return Signer;
  try {
    // eslint-disable-next-line global-require
    ({ Signer } = require('@aws-sdk/rds-signer'));
  } catch {
    Signer = false;
  }
  return Signer;
}

/**
 * Build a pg client config that authenticates with IAM, or return null when the
 * environment is not configured for it (local, tests) so the caller falls back
 * to a connection string.
 */
function iamClientConfig({ host, port, database, user, region }) {
  if (!host || !user) return null;
  const SignerClass = loadSigner();
  if (!SignerClass) {
    // Explicit rather than a silent fallback to no password: a production task
    // that cannot mint a token must fail loudly, not attempt a passwordless
    // connection and report an authentication error that looks like a bad
    // credential.
    throw new Error(
      'DB_HOST is set for IAM authentication but @aws-sdk/rds-signer is not installed',
    );
  }

  return {
    host,
    port: Number(port || 5432),
    database,
    user,
    // Called on every new connection, so the token is never stale.
    password: async () => {
      const signer = new SignerClass({
        hostname: host,
        port: Number(port || 5432),
        username: user,
        region: region || process.env.AWS_REGION,
      });
      return signer.getAuthToken();
    },
    // RDS requires TLS and `rds.force_ssl` is set on the parameter group, so
    // this is not optional. Verification is on: without it TLS proves only that
    // something answered on 5432, which is not what it is for. The RDS CA
    // bundle is mounted into the image at deploy time.
    ssl: {
      rejectUnauthorized: true,
      ca: process.env.RDS_CA_BUNDLE || undefined,
    },
  };
}

module.exports = { iamClientConfig };
