#!/usr/bin/env node
/**
 * Check the deploy can succeed, before spending twenty minutes finding out it
 * cannot.
 *
 *   node preflight.mjs \
 *     -c apiCertArn=arn:aws:acm:us-east-2:…  -c webCertArn=arn:aws:acm:us-east-1:… \
 *     -c apiDomain=api.example.com -c webDomain=app.example.com
 *
 * Every check here corresponds to a way this deploy actually fails, and each
 * one fails LATE and expensively without it:
 *
 *   - a CloudFront certificate outside us-east-1 is accepted by ACM, accepted
 *     by CDK, and rejected by CloudFront after the rest of the stack is up;
 *   - a certificate still PENDING_VALIDATION deploys and then serves nothing;
 *   - no CDK bootstrap fails at asset publishing, after synthesis;
 *   - Docker not running fails when the server image is built, which is after
 *     CloudFormation has started changing things.
 *
 * Read-only. It calls `aws` and `docker` and changes nothing.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

/** `-c key=value`, the same form cdk takes, so one line copies to the other. */
export function parseContext(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // Accept `-c k=v`, `--context k=v`, and `-ck=v`.
    let pair = null;
    if ((arg === '-c' || arg === '--context') && argv[i + 1]) { pair = argv[i + 1]; i += 1; } else if (arg.startsWith('-c') && arg.includes('=')) pair = arg.slice(2);
    else if (arg.startsWith('--context=')) pair = arg.slice('--context='.length);
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * The region an ACM ARN names.
 *
 * Parsed from the ARN rather than asked of AWS, because the whole point is to
 * catch a certificate in the wrong region — and describing it requires knowing
 * which region to ask, which is the thing in question.
 */
export function arnRegion(arn) {
  const parts = String(arn).split(':');
  return parts.length > 3 && parts[0] === 'arn' ? parts[3] : null;
}

/** CloudFront reads certificates from exactly one region. */
export const CLOUDFRONT_CERT_REGION = 'us-east-1';

export function checkCertRegions({ apiCertArn, webCertArn }) {
  const problems = [];
  if (!apiCertArn) {
    problems.push({
      fatal: true,
      message: 'apiCertArn is missing. The platform stack refuses to synthesize without it, '
        + 'rather than serving session cookies over plaintext HTTP.',
    });
  }
  if (webCertArn) {
    const region = arnRegion(webCertArn);
    if (region !== CLOUDFRONT_CERT_REGION) {
      problems.push({
        fatal: true,
        message: `webCertArn is in ${region || 'an unreadable region'}, and CloudFront reads `
          + `certificates only from ${CLOUDFRONT_CERT_REGION}. ACM will accept this certificate `
          + 'and CDK will accept this ARN; CloudFront rejects it after the rest of the stack is '
          + `up. Reissue the web certificate in ${CLOUDFRONT_CERT_REGION}.`,
      });
    }
  }
  return problems;
}

/**
 * Run a command, returning `null` rather than throwing when it is absent or
 * fails. A preflight that crashes on its first missing tool reports one problem
 * per run; the operator wants the whole list.
 */
async function tryRun(cmd, args, exec = run) {
  try {
    const { stdout } = await exec(cmd, args);
    return String(stdout).trim();
  } catch {
    return null;
  }
}

export async function preflight(context, { exec = run, log = process.stdout } = {}) {
  const results = [];
  const add = (name, state, detail) => { results.push({ name, state, detail }); };

  // ── Things that need no AWS call ─────────────────────────────────────────
  for (const p of checkCertRegions(context)) add('certificate region', 'fail', p.message);
  if (context.webCertArn && arnRegion(context.webCertArn) === CLOUDFRONT_CERT_REGION) {
    add('certificate region', 'ok', `web certificate is in ${CLOUDFRONT_CERT_REGION}`);
  }

  const tier = context.tier || 'production';
  if (!['production', 'lean'].includes(tier)) {
    add('tier', 'fail', `tier must be "production" or "lean"; got ${JSON.stringify(tier)}`);
  } else {
    add('tier', 'ok', `${tier}${tier === 'production' ? C.dim(' (~$250/mo more than lean)') : ''}`);
  }

  if (!context.alertEmail) {
    // Not fatal, and not harmless: every alarm still deploys and still
    // evaluates, and nobody is told when one fires.
    add('alerts', 'warn', 'no alertEmail: twenty alarms will deploy and notify nobody');
  }

  // ── Credentials and account ──────────────────────────────────────────────
  const identity = await tryRun('aws', ['sts', 'get-caller-identity', '--output', 'json'], exec);
  if (!identity) {
    add('aws credentials', 'fail', 'aws sts get-caller-identity failed. Run `aws configure`.');
  } else {
    let who = {};
    try { who = JSON.parse(identity); } catch { /* reported below */ }
    if (who.Account) add('aws credentials', 'ok', `account ${who.Account} as ${who.Arn || 'unknown'}`);
    else add('aws credentials', 'fail', 'get-caller-identity returned no account');
  }

  const region = await tryRun('aws', ['configure', 'get', 'region'], exec)
    || process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION;
  if (!region) add('region', 'warn', 'no default region; bin/ falls back to us-east-1');
  else add('region', 'ok', region);

  // ── Certificates exist and are ISSUED ────────────────────────────────────
  for (const [key, arn] of [['apiCertArn', context.apiCertArn], ['webCertArn', context.webCertArn]]) {
    if (!arn) continue;
    const certRegion = arnRegion(arn);
    const described = await tryRun('aws', [
      'acm', 'describe-certificate', '--certificate-arn', arn,
      '--region', certRegion, '--output', 'json',
    ], exec);
    if (!described) {
      add(key, 'fail', `describe-certificate failed in ${certRegion}. Wrong account, or the ARN is wrong.`);
      continue;
    }
    let cert = {};
    try { cert = JSON.parse(described).Certificate || {}; } catch { /* below */ }
    if (cert.Status === 'ISSUED') {
      add(key, 'ok', `${cert.DomainName || '?'} ISSUED in ${certRegion}`);
    } else {
      add(key, 'fail', `status is ${cert.Status || 'unreadable'}, not ISSUED. `
        + 'A PENDING_VALIDATION certificate deploys and then serves nothing.');
    }
  }

  // ── CDK bootstrap ────────────────────────────────────────────────────────
  const bootstrap = await tryRun('aws', [
    'cloudformation', 'describe-stacks', '--stack-name', 'CDKToolkit', '--output', 'json',
  ], exec);
  if (bootstrap) add('cdk bootstrap', 'ok', 'CDKToolkit present');
  else add('cdk bootstrap', 'fail', 'no CDKToolkit stack in this account/region. Run `npx cdk bootstrap`.');

  // ── Docker, which builds the server image ────────────────────────────────
  const docker = await tryRun('docker', ['info', '--format', '{{.ServerVersion}}'], exec);
  if (docker) add('docker', 'ok', `daemon ${docker}`);
  else {
    add('docker', 'fail', 'docker is not running. The stack builds the API image from ../server '
      + 'with ContainerImage.fromAsset, and that happens AFTER CloudFormation has started.');
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const fails = results.filter((r) => r.state === 'fail');
  const warns = results.filter((r) => r.state === 'warn');

  log.write(`\n${C.bold('Deploy preflight')}\n\n`);
  for (const r of results) {
    const mark = r.state === 'ok' ? C.ok('✓') : r.state === 'warn' ? C.warn('!') : C.bad('✗');
    log.write(`  ${mark} ${r.name.padEnd(20)} ${r.state === 'fail' ? C.bad(r.detail) : C.dim(r.detail)}\n`);
  }

  log.write(fails.length
    ? `\n${C.bad(`${fails.length} blocking problem${fails.length === 1 ? '' : 's'}.`)} `
      + C.dim('Fix these before cdk deploy; each one fails late and expensively.\n\n')
    : `\n${C.ok('Ready to deploy.')}${warns.length ? C.warn(` ${warns.length} warning(s) above.`) : ''}\n\n`);

  return { results, ok: fails.length === 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok } = await preflight(parseContext(process.argv.slice(2)));
  process.exit(ok ? 0 : 1);
}
