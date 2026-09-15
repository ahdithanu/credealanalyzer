'use strict';

const express = require('express');
const { rateLimit } = require('../middleware/rateLimit');
const { securityEvent, KIND } = require('../obs/securityLog');

/**
 * The Content-Security-Policy violation collector.
 *
 * The CSP in infra/lib/web.js is the control that limits the damage of an XSS
 * bug: `connect-src` naming only our own API is what stops injected script
 * shipping a client firm's pipeline to a host of the attacker's choosing. Until
 * now that policy was enforced and SILENT. A browser that refused to load an
 * injected script told the browser's own console and nobody else, which means
 * the single clearest signal that someone is attempting injection against a
 * client firm's analyst was being discarded at the point it was generated.
 *
 * This endpoint turns that into an alarm. It is deliberately the smallest thing
 * that can do that job, because of what it is:
 *
 *   UNAUTHENTICATED AND INTERNET-FACING. A browser sends a violation report
 *   with no credentials — that is in the spec, not an oversight — so this route
 *   cannot sit behind requireSession. Anyone at all can POST to it.
 *
 * Which drives every other decision here:
 *
 *   - It writes NOTHING to the database. An unauthenticated write path into
 *     Postgres is a denial-of-service surface against every tenant's storage
 *     and connection pool, in exchange for a table nobody queries. The report
 *     goes to the log, where CloudWatch turns it into a metric and an alarm.
 *   - It is rate limited hard, and separately from everything else. A single
 *     page under sustained attack can emit a report per blocked resource per
 *     load; an attacker can do considerably better than that on purpose.
 *   - Identical reports are suppressed for a window. One misconfigured
 *     third-party script would otherwise emit the same line from every browser
 *     on every page load, at our expense, forever.
 *   - The body is capped at 8KB — far below the 1MB the API allows elsewhere —
 *     because a report is a few hundred bytes and the `script-sample` field is
 *     attacker-chosen text.
 *   - It always answers 204, whatever arrives. A parse error that returned 400
 *     would tell a prober what this endpoint accepts, and a browser has nothing
 *     useful to do with the answer either way.
 *
 * TWO WIRE FORMATS. `report-uri` (CSP Level 2) posts a single
 * `application/csp-report` body wrapped in a `csp-report` key; the Reporting
 * API (`report-to` / `Reporting-Endpoints`) posts an ARRAY under
 * `application/reports+json`. Browsers are split across the two and will be for
 * years, so infra/lib/web.js emits both directives and this accepts both
 * shapes. Handling only the first would mean collecting nothing from Chrome.
 */

/** Everything worth keeping from a report, and nothing else. */
const FIELDS = [
  'documentURI', 'referrer', 'violatedDirective', 'effectiveDirective',
  'originalPolicy', 'disposition', 'blockedURI', 'statusCode',
  'scriptSample', 'sourceFile', 'lineNumber', 'columnNumber',
];

/**
 * The two formats spell the same fields differently — `blocked-uri` in the
 * Level 2 report, `blockedURI` in the Reporting API. Normalising to one shape
 * means the metric filter and the alarm do not have to know which browser sent
 * it.
 */
function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of FIELDS) {
    const kebab = key.replace(/[A-Z]+/g, (m) => `-${m.toLowerCase()}`);
    const v = raw[key] ?? raw[kebab];
    if (v !== undefined && v !== null && v !== '') out[key] = v;
  }
  // A report with no directive is not a report. Refusing to log it is what
  // stops this endpoint being a free, structured, alarm-raising writer into our
  // log group for anyone who can POST arbitrary JSON.
  if (!out.effectiveDirective && !out.violatedDirective) return null;
  return out;
}

/** Pull the report objects out of either wire format. */
function extract(body) {
  // Reporting API: an array of envelopes, only some of which are CSP.
  if (Array.isArray(body)) {
    return body
      .filter((e) => e && e.type === 'csp-violation' && e.body)
      .map((e) => normalise(e.body));
  }
  if (body && typeof body === 'object') {
    // CSP Level 2: { "csp-report": { ... } }
    if (body['csp-report']) return [normalise(body['csp-report'])];
    // Some agents post the bare report. Accept it rather than lose it.
    return [normalise(body)];
  }
  return [];
}

/**
 * Suppression. Keyed on the directive and the blocked URI, which is the pair
 * that identifies "the same violation" — the document URI is not in the key,
 * because the same injected script blocked on a hundred different deal pages is
 * one event, not a hundred.
 */
const SUPPRESS_MS = 10 * 60 * 1000;
const SUPPRESS_MAX = 500;
const seen = new Map();

function shouldEmit(report, now) {
  const key = `${report.effectiveDirective || report.violatedDirective}|${report.blockedURI || ''}`;
  const until = seen.get(key);
  if (until !== undefined && until > now) return false;
  // Bounded: an attacker who varies the blocked URI on every request would
  // otherwise grow this map without limit. Oldest-first because Map preserves
  // insertion order, so the eviction is the least recently ADDED key.
  if (seen.size >= SUPPRESS_MAX) {
    for (const [k, v] of seen) {
      if (v <= now) seen.delete(k);
    }
    while (seen.size >= SUPPRESS_MAX) {
      seen.delete(seen.keys().next().value);
    }
  }
  seen.set(key, now + SUPPRESS_MS);
  return true;
}

function cspReportRoutes() {
  const r = express.Router();

  // 60 a minute per address. A legitimate browser on a page with a genuine
  // policy problem sends a handful; a page under active attack sends more, and
  // the suppression above means we do not need every copy to raise the alarm.
  r.use(rateLimit({ name: 'csp', limit: 60, windowMs: 60_000 }));

  // Claim every content type a browser uses for this, and nothing else. The
  // global express.json() in app.js does not claim these, which is why this
  // router brings its own parser.
  r.use(express.json({
    type: ['application/csp-report', 'application/reports+json', 'application/json'],
    limit: '8kb',
  }));

  r.post('/', (req, res) => {
    const now = Date.now();
    for (const report of extract(req.body)) {
      if (!report) continue;
      if (!shouldEmit(report, now)) continue;
      // Every value here is attacker-influenced — `blockedURI` and
      // `scriptSample` most obviously. securityEvent caps each one, and
      // JSON.stringify escapes the newlines that would otherwise let a crafted
      // sample forge a second log line and a second alarm.
      securityEvent(KIND.CSP_VIOLATION, {
        directive: report.effectiveDirective || report.violatedDirective,
        blockedURI: report.blockedURI,
        documentURI: report.documentURI,
        sourceFile: report.sourceFile,
        line: report.lineNumber,
        sample: report.scriptSample,
        // 'report' means the policy was in report-only mode and did NOT block.
        // Distinguishing them matters: 'enforce' says an attack was stopped,
        // 'report' says one would not have been.
        disposition: report.disposition || 'enforce',
      });
    }
    res.status(204).end();
  });

  // A malformed body reaches here as a parser error. 204 as well: see the note
  // at the top on why this endpoint never tells a caller anything.
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    res.status(204).end();
  });

  return r;
}

/** Tests only. */
function __reset() { seen.clear(); }

module.exports = { cspReportRoutes, __reset, normalise, extract };
