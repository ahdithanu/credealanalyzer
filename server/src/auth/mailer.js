'use strict';

const config = require('../config');

/**
 * Outbound mail, behind an interface — the same shape as broker.js and for the
 * same reason.
 *
 * The security-critical logic of a magic link is not the sending. It is which
 * tenant the address resolves to, whether the link is single-use, and whether
 * the firm's MFA policy survives the new path. All of that has to be testable
 * without a vendor account, an API key, or outbound network, so the transport
 * is a seam.
 *
 * The contract:
 *   send({ to, subject, text }) -> Promise<void>
 *
 * It resolves on accepted-for-delivery and throws otherwise. It does not
 * promise the mail arrived; nothing can.
 *
 * NO VENDOR IS BUNDLED. This repository declares two runtime dependencies and
 * has a supply-chain job and an SBOM, so adding an SES or Postmark client is a
 * decision for whoever owns the deploy, not something a feature branch should
 * make on their behalf. `ses` below is a lazily-required adapter: the moment
 * the package is installed it works, and until then it fails with the install
 * line in the message.
 *
 * EVERY CHECK HERE IS AT FIRST SEND, NOT AT STARTUP, and that is a deliberate
 * trade rather than laziness. Magic links are enabled per tenant, so a
 * deployment whose firms all use SSO never sends a message — and making such a
 * deployment configure a sending identity it will never use is friction with
 * no safety behind it. The same reasoning as the Duo guard in config.js, which
 * fires only when `duo.configKey` is set. The cost is that a misconfigured
 * mailer surfaces on the first magic-link login rather than at boot; the
 * errors below are written to make that moment unambiguous.
 */

// ─── Stub ────────────────────────────────────────────────────────────────────

/**
 * Captures messages in memory. Tests read `sent`; nothing leaves the process.
 *
 * Exported rather than reached through the factory so a test can assert on the
 * actual link that was mailed — the single most important assertion available
 * here, since a link that is correct in the database and wrong in the mail is
 * a login that does not work.
 */
const sent = [];

const stubMailer = {
  async send({ to, subject, text }) {
    sent.push({ to, subject, text, at: new Date() });
  },
};

/** Tests call this between cases. */
function __resetMail() { sent.length = 0; }

// ─── Log ─────────────────────────────────────────────────────────────────────

/**
 * Writes the message to stdout instead of sending it. For local development
 * against a real database, where a working inbox is not worth standing up.
 *
 * Deliberately NOT available when config.isProd: a provider that prints login
 * links into a log aggregator in production is a credential in the logs.
 */
const logMailer = {
  async send({ to, subject, text }) {
    process.stdout.write(JSON.stringify({
      evt: 'mail.not_sent', provider: 'log', to, subject, text,
    }) + '\n');
  },
};

// ─── SES ─────────────────────────────────────────────────────────────────────

function sesMailer() {
  let client, SendEmailCommand;
  try {
    // Required lazily so the package is needed only by deployments that choose
    // this provider. A top-level require would make every test run and every
    // `log`-provider dev environment depend on it.
    /* eslint-disable global-require */
    const sdk = require('@aws-sdk/client-sesv2');
    SendEmailCommand = sdk.SendEmailCommand;
    client = new sdk.SESv2Client({ region: config.mail.region });
  } catch (err) {
    throw new Error(
      'MAIL_PROVIDER=ses needs the AWS SES client, which is not installed. '
      + 'Run `npm i @aws-sdk/client-sesv2` in server/, or set MAIL_PROVIDER to '
      + 'another provider.',
    );
  }
  return {
    async send({ to, subject, text }) {
      await client.send(new SendEmailCommand({
        FromEmailAddress: config.mail.from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' } },
        } },
      }));
    },
  };
}

// ─── Selection ───────────────────────────────────────────────────────────────

function build() {
  // A real sending address is needed by every provider that actually sends.
  if (config.isProd && config.mail.from === 'no-reply@localhost') {
    throw new Error('MAIL_FROM must be a real sending address in production');
  }
  switch (config.mail.provider) {
    case 'stub':
      // Accepts every message and sends none. In production that is a login
      // that fails with no error anywhere: the link is minted, the row is
      // written, and nothing arrives.
      if (config.isProd) {
        throw new Error('MAIL_PROVIDER=stub is a test fixture and must never run in production');
      }
      return stubMailer;
    case 'log':
      if (config.isProd) {
        throw new Error(
          'MAIL_PROVIDER=log writes sign-in links to stdout, which in production '
          + 'puts a live credential into the log aggregator. Choose a real provider.',
        );
      }
      return logMailer;
    case 'ses': return sesMailer();
    default:
      throw new Error(`Unknown MAIL_PROVIDER: ${config.mail.provider}`);
  }
}

let instance = null;
/** Built on first use so an unknown provider fails at the first send, not at import. */
function mailer() {
  if (!instance) instance = build();
  return instance;
}
/** Tests swap providers between cases. */
function __resetMailer() { instance = null; }

module.exports = { mailer, sent, __resetMail, __resetMailer, stubMailer };
