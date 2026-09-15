'use strict';

const crypto = require('crypto');
const express = require('express');
const provisioning = require('../auth/provisioning');
const { withTenant } = require('../db/pool');

/**
 * SCIM 2.0 user provisioning — and the deprovisioning that is the point of it.
 *
 * Disabling an analyst in the customer's directory stops new logins and does
 * nothing at all to the session they are holding, which stays valid for up to
 * the full session lifetime. For a departing analyst with a client firm's
 * pipeline on screen, that window is the entire exposure. So the operation that
 * matters here is PATCH active=false, and what it must do is deactivate the
 * account AND revoke every live session of that person in the SAME transaction.
 * A deprovisioning that leaves a session alive is not a deprovisioning.
 *
 * THE CALLER IS A MACHINE, which changes the authentication story completely:
 *
 *   - No cookie, no CSRF token, no origin. A per-tenant bearer token instead,
 *     stored only as a hash and compared in constant time — see
 *     auth/provisioning.js, which also explains why minting one is an operator
 *     CLI and not a route.
 *   - THE TOKEN DETERMINES THE TENANT. Nothing in this file reads a tenant from
 *     a header, a path parameter or the body, and the row level security in
 *     migration 007 means that a query here which forgot its predicate returns
 *     nothing rather than another firm's users.
 *   - Its own rate limit, because one credential that can enumerate and
 *     deactivate every user in a firm should not inherit the ceiling meant for
 *     an analyst clicking around a pipeline.
 *
 * ERRORS ARE SCIM-SHAPED. A directory that receives our ordinary
 * `{"error":"..."}` reports "sync failed" to an administrator with nothing
 * actionable in it; the same administrator with a SCIM error document can see
 * that the token was rejected, or that a userName collided.
 */

const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCHEMA_PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SCHEMA_SERVICE_PROVIDER = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';

const CONTENT_TYPE = 'application/scim+json;charset=utf-8';
const MAX_PAGE = 200;
const DEFAULT_PAGE = 100;

/**
 * A SCIM error document.
 *
 * `status` is a STRING in the SCIM schema, not a number — several directories
 * reject the numeric form outright, which surfaces as "invalid response from
 * the SCIM server" and tells the administrator nothing about the real problem.
 *
 * `detail` is written for the administrator reading a sync report, and says
 * nothing that helps someone probing: every authentication failure produces the
 * same sentence whether the token was unknown, wrong, revoked, expired or
 * belonged to a suspended tenant.
 */
function scimError(res, status, detail, scimType) {
  res.status(status).type(CONTENT_TYPE).json({
    schemas: [SCHEMA_ERROR],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  });
}

/**
 * A user row as a SCIM resource.
 *
 * WHAT IS NOT INVENTED HERE. We store one `name` column, so `givenName` and
 * `familyName` are null: splitting "An Analyst" on a space guesses which half
 * is the family name, and that guess is wrong for a large share of the world's
 * names. A null says we do not hold it. Likewise `meta.lastModified` is null
 * for rows that predate the column rather than being backfilled with a
 * plausible date — a directory reads lastModified to decide what to re-sync.
 */
function toScimUser(row, location) {
  return {
    schemas: [SCHEMA_USER],
    id: row.id,
    externalId: row.scim_external_id,
    userName: row.email,
    name: {
      formatted: row.name,
      givenName: null,
      familyName: null,
    },
    displayName: row.name,
    emails: [{ value: row.email, primary: true, type: 'work' }],
    active: row.active,
    meta: {
      resourceType: 'User',
      created: row.created_at ? new Date(row.created_at).toISOString() : null,
      lastModified: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      location: `${location}/Users/${row.id}`,
    },
  };
}

/** Where this deployment serves SCIM, for meta.location. */
function baseLocation(req) {
  const host = req.headers.host;
  if (!host) return '/scim/v2';
  // `req.protocol` honours the ALB's X-Forwarded-Proto because app.js sets
  // `trust proxy: 1`; without that every location would claim http.
  return `${req.protocol}://${host}/scim/v2`;
}

/**
 * Coerce a SCIM boolean, or null when it is not one.
 *
 * ENTRA ID SENDS THE STRING "False". Passing that through `Boolean()` yields
 * true, the account stays active, the sync reports success, and the analyst the
 * customer just disabled keeps their access — the precise failure this whole
 * feature exists to prevent, arriving as a silent success. Anything that is not
 * recognisably a boolean returns null, and the caller rejects the request
 * rather than choosing a value on the directory's behalf.
 */
function scimBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}

/** The display name a directory is telling us, without inventing one. */
function displayNameFrom(body) {
  const n = body && typeof body.name === 'object' && body.name ? body.name : null;
  if (n && typeof n.formatted === 'string' && n.formatted.trim()) return n.formatted.trim();
  if (n) {
    const parts = [n.givenName, n.familyName]
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim());
    if (parts.length) return parts.join(' ');
  }
  if (typeof body?.displayName === 'string' && body.displayName.trim()) {
    return body.displayName.trim();
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The userName a directory supplied, normalised the same way the login path
 * normalises an asserted email.
 *
 * They must match: `users` is unique on (tenant_id, email), and a SCIM-created
 * "Analyst@FirmX.com" that does not collide with the login path's
 * "analyst@firmx.com" becomes two rows for one person — one of which the
 * directory can deprovision and the other of which keeps its sessions.
 */
function normaliseUserName(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) return null;
  return email;
}

// ─── Rate limiting ──────────────────────────────────────────────────────────
//
// Separate from middleware/rateLimit.js, for two reasons that are specific to
// this surface.
//
// KEYED ON THE TOKEN, NOT THE ADDRESS. Okta, Entra and WorkOS call from shared
// egress addresses used by every one of their customers. An address-keyed
// limiter here would let one busy directory exhaust the budget of an unrelated
// firm's sync — a limiter that produces cross-tenant impact is the wrong shape
// for a multi-tenant boundary. The key is a digest of the presented token, so
// each directory credential gets its own ceiling and no database work is needed
// to compute it.
//
// A SECOND, SMALLER CEILING ON FAILURES PER ADDRESS. Keying only on the token
// would let an attacker rotate made-up tokens to get a fresh bucket every time,
// which is exactly the brute force a limiter is meant to stop. Requests that
// fail to authenticate are counted per address instead, and once that ceiling
// is reached further attempts are refused before any database lookup.
//
// In memory, with the same honest caveat as middleware/rateLimit.js: with N
// tasks a caller gets N times the limit and a restart forgets everything. It is
// a defence-in-depth layer behind the WAF, not the system of record.

const buckets = new Map();
let lastSweep = 0;

function hit(key, limit, windowMs) {
  const now = Date.now();
  if (now - lastSweep > windowMs) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    lastSweep = now;
  }
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return { over: b.count > limit, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
}

const WINDOW_MS = 60_000;
// A full directory sync of a large firm is a few hundred calls; ordinary
// incremental syncs are single figures. This is generous for both and far below
// what enumerating a firm's whole user list at speed would need.
const PER_TOKEN_LIMIT = 120;
// Calls arriving with no credential at all get much less: nothing legitimate
// does that more than once, while discovery scans do it constantly.
const ANONYMOUS_LIMIT = 20;
// Failed authentications per address, across all tokens tried.
const FAILURE_LIMIT = 30;

function refuse(res, retryAfter) {
  res.setHeader('Retry-After', String(retryAfter));
  scimError(res, 429, 'Too many requests. Retry after the interval in the Retry-After header.');
}

/**
 * Authenticate the request, rate limit it, and attach the tenant.
 *
 * `req.scim.tenantId` is the ONLY tenant any handler below may use, and it came
 * from the token. Nothing here reads one from the request, and no handler
 * should either — the note at the top of auth/session.js explains what happens
 * when something does.
 */
function requireScimToken() {
  return async (req, res, next) => {
    try {
      const presented = provisioning.bearerToken(req.headers.authorization);
      const ip = req.ip || 'unknown';

      const failures = buckets.get(`scim:fail:${ip}`);
      if (failures && failures.resetAt > Date.now() && failures.count > FAILURE_LIMIT) {
        refuse(res, Math.ceil((failures.resetAt - Date.now()) / 1000));
        return;
      }

      const bucket = presented
        // A digest, so the credential itself is never a map key that a heap
        // dump or a debugger would show.
        ? { key: `scim:tok:${crypto.createHash('sha256').update(presented).digest('hex')}`, limit: PER_TOKEN_LIMIT }
        : { key: `scim:anon:${ip}`, limit: ANONYMOUS_LIMIT };
      const limited = hit(bucket.key, bucket.limit, WINDOW_MS);
      if (limited.over) { refuse(res, limited.retryAfter); return; }

      const actor = await provisioning.authenticate(req.headers.authorization);
      if (!actor) {
        hit(`scim:fail:${ip}`, FAILURE_LIMIT, WINDOW_MS);

        // A failed authentication against the highest-privilege standing
        // credential in the system — a SCIM token can enumerate and deactivate
        // every user in a tenant — must leave a trace. It previously left none
        // at all: not an audit row, not a log line, not even last_used_at. A
        // review after an incident would find no evidence that anyone had ever
        // probed it.
        //
        // Logged rather than written to audit_log, deliberately: the audit log
        // is tenant-scoped and an unauthenticated caller has no tenant, so
        // there is no row to write without inventing an attribution. The token
        // id half is recorded because it is the part an operator may have
        // pasted somewhere and is what identifies WHICH credential is being
        // probed; the secret half never is.
        console.error(JSON.stringify({
          level: 'warn',
          msg: 'scim.auth_failed',
          tokenId: tokenIdFromHeader(req) || null,
          ip,
          path: req.originalUrl,
          at: new Date().toISOString(),
        }));

        // ONE answer for every cause: unknown token, wrong secret, revoked,
        // expired, suspended tenant. Anything finer is an oracle — and since a
        // tenant is never named in the request, a caller must not be able to
        // learn from the response whether one exists.
        res.setHeader('WWW-Authenticate', 'Bearer realm="scim"');
        scimError(res, 401, 'The bearer token is missing, invalid or no longer active.');
        return;
      }

      req.scim = actor;
      next();
    } catch (err) { next(err); }
  };
}

/** Tests only. */
function __resetRateLimit() { buckets.clear(); lastSweep = 0; }

// ─── PATCH ──────────────────────────────────────────────────────────────────

class ScimFault extends Error {
  constructor(status, detail, scimType) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.scimType = scimType;
  }
}

/**
 * Reduce a PatchOp body to the fields we store.
 *
 * Directories disagree about the shape in ways that are not optional to handle:
 * Okta sends `{op:"replace", value:{active:false}}` with no path, Entra sends
 * `{op:"Replace", path:"active", value:"False"}` with a capitalised op and a
 * STRING, and both are ordinary traffic. Getting either wrong means a
 * deprovisioning request that returns 200 and changes nothing.
 *
 * Unknown attributes are IGNORED rather than rejected, and that is deliberate:
 * a directory sends title, department, manager and a dozen enterprise-extension
 * attributes in the same PATCH as `active`, and answering 400 because we do not
 * store `department` would refuse the deprovisioning riding along with it.
 */
function applyPatch(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ScimFault(400, 'A PATCH must contain at least one operation in "Operations".', 'invalidSyntax');
  }
  const patch = {};
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object') {
      throw new ScimFault(400, 'Each entry in "Operations" must be an object.', 'invalidSyntax');
    }
    const op = typeof raw.op === 'string' ? raw.op.trim().toLowerCase() : null;
    if (!['add', 'replace', 'remove'].includes(op)) {
      throw new ScimFault(400, `Unsupported patch operation "${raw.op}".`, 'invalidSyntax');
    }
    // A path may be absent, in which case `value` is an object of attributes.
    const entries = raw.path === undefined || raw.path === null || raw.path === ''
      ? Object.entries(raw.value && typeof raw.value === 'object' ? raw.value : {})
      : [[String(raw.path), raw.value]];

    for (const [path, value] of entries) {
      // Strip any schema URN prefix: Entra addresses core attributes as
      // "urn:ietf:params:scim:schemas:core:2.0:User:active".
      const attr = path.split(':').pop().trim();
      switch (attr.toLowerCase()) {
        case 'active': {
          // `remove active` is not a thing any directory means kindly, and the
          // safe reading of "remove the flag that says they may sign in" is
          // false rather than a default of true.
          const next = op === 'remove' ? false : scimBoolean(value);
          if (next === null) {
            throw new ScimFault(400,
              `"active" must be a boolean or the strings "true"/"false"; received ${JSON.stringify(value)}.`,
              'invalidValue');
          }
          patch.active = next;
          break;
        }
        case 'username': {
          const email = normaliseUserName(value);
          if (!email) throw new ScimFault(400, '"userName" must be an email address.', 'invalidValue');
          patch.email = email;
          break;
        }
        case 'externalid':
          patch.scimExternalId = op === 'remove' ? null
            : (typeof value === 'string' && value.trim() ? value.trim() : null);
          break;
        case 'displayname':
        case 'name':
        case 'name.formatted': {
          if (op === 'remove') { patch.name = null; break; }
          patch.name = typeof value === 'string'
            ? (value.trim() || null)
            : displayNameFrom({ name: value });
          break;
        }
        default:
          // Deliberately silent. See the note above this function.
          break;
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ScimFault(400, 'The patch contained no attribute this service stores.', 'noTarget');
  }
  return patch;
}

// ─── Filters ────────────────────────────────────────────────────────────────

const FILTER_RE = /^\s*(userName|externalId|id)\s+eq\s+"([^"]*)"\s*$/i;

/**
 * The one filter form a directory actually needs.
 *
 * Okta and Entra both look a user up by `userName eq "..."` before deciding
 * whether to create or update, so this is the filter that makes provisioning
 * work at all. Everything else is refused with `invalidFilter` rather than
 * silently ignored: a filter the server drops returns the whole user list, and
 * a directory that asked "does this person exist" and received everyone will
 * act on the first row it sees.
 */
function parseFilter(filter) {
  if (filter === undefined || filter === null || filter === '') return null;
  if (typeof filter !== 'string') {
    throw new ScimFault(400, 'Unsupported filter.', 'invalidFilter');
  }
  const m = FILTER_RE.exec(filter);
  if (!m) {
    throw new ScimFault(400,
      'Only filters of the form \'userName eq "value"\' (or externalId, id) are supported.',
      'invalidFilter');
  }
  return { attribute: m[1].toLowerCase(), value: m[2] };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const USER_COLUMNS = `id, email, name, external_id, scim_external_id,
                      active, deactivated_at, created_at, updated_at`;


/**
 * The PUBLIC half of a presented token, for logging a failed attempt.
 *
 * A SCIM token is `scim_<id>_<secret>`. The id identifies which credential is
 * being probed — worth recording, and the part an operator may have pasted into
 * a ticket. The secret is never returned by this function, so no caller can log
 * it by accident.
 */
function tokenIdFromHeader(req) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const parts = raw.split('_');
  if (parts.length < 3 || parts[0] !== 'scim') return null;
  return parts[1].slice(0, 64);
}

function scimRoutes() {
  const r = express.Router();

  // ORDER IS LOAD-BEARING, and it used to be the other way round.
  //
  // The body parser was mounted FIRST. A request whose body failed to parse
  // short-circuited to the router's error handler, so it reached neither the
  // rate limiter nor the token check: 1,000 unauthenticated POSTs carrying `{`
  // drew 1,000 × 400 in under two seconds and not one 429. A limiter that is
  // stepped around by sending broken JSON is not a limiter, and SCIM is
  // deliberately outside the API-wide limiter, so nothing else catches it.
  //
  // Authentication — which carries the limiter — now runs first, so an
  // anonymous caller cannot make this process parse anything at all.
  r.use(requireScimToken());

  // Directories send `application/scim+json`, which the API-wide JSON parser in
  // app.js does not claim. Without this the body arrives undefined and every
  // create looks like a request with no userName.
  r.use(express.json({ type: ['application/scim+json', 'application/json'], limit: '512kb' }));

  /**
   * What this service supports, as the SCIM schema describes it.
   *
   * Not audited, unlike every operation below: it is a constant document that
   * reads no tenant data and names no person. Auditing it would add a row for
   * every sync cycle and make the entries that do matter harder to find.
   */
  r.get('/ServiceProviderConfig', (req, res) => {
    res.type(CONTENT_TYPE).json({
      schemas: [SCHEMA_SERVICE_PROVIDER],
      // No documentationUri: the attribute is optional, and pointing it at a
      // URL that is not documentation is worse than leaving it out.
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_PAGE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      // Bearer only. A directory that discovers we accept HTTP Basic would
      // happily send a password, and there is no password here to send.
      authenticationSchemes: [{
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'A per-tenant bearer token issued by an operator.',
        primary: true,
      }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${baseLocation(req)}/ServiceProviderConfig` },
    });
  });

  /** List, or look one user up by filter. */
  r.get('/Users', async (req, res, next) => {
    try {
      const filter = parseFilter(req.query.filter);
      const startIndex = Math.max(1, Number(req.query.startIndex) || 1);
      const count = Math.min(MAX_PAGE, Math.max(0, Number(req.query.count) || DEFAULT_PAGE));

      // An `id eq "not-a-uuid"` filter is a question with a known answer, and
      // asking Postgres to cast it would produce a 500 rather than "no match".
      const unmatchable = filter?.attribute === 'id' && !UUID_RE.test(filter.value);

      const { rows, total } = await provisioning.withScimTenant(req.scim.tenantId, async (db) => {
        if (unmatchable) return { rows: [], total: 0 };
        // No tenant predicate, deliberately: the policies in migration 007
        // scope this to the token's tenant, so a predicate forgotten here
        // returns nothing rather than every firm's people.
        const WHERE = `WHERE ($1::text IS NULL OR lower(email) = $1)
              AND ($2::text IS NULL OR scim_external_id = $2)
              AND ($3::uuid IS NULL OR id = $3::uuid)`;
        const countParams = [
          filter?.attribute === 'username' ? String(filter.value).trim().toLowerCase() : null,
          filter?.attribute === 'externalid' ? filter.value : null,
          filter?.attribute === 'id' ? filter.value : null,
        ];
        const countSql = `SELECT count(*)::bigint AS total FROM users ${WHERE}`;

        const q = await db.query(
          `SELECT ${USER_COLUMNS}, count(*) OVER() AS total
             FROM users
            ${WHERE}
            ORDER BY created_at, id
            LIMIT $4 OFFSET $5`,
          [...countParams, count, startIndex - 1],
        );
        await provisioning.recordScim(db, {
          tenantId: req.scim.tenantId,
          action: 'scim.user.listed',
          subjectId: null,
          detail: { filter: req.query.filter || null, returned: q.rows.length },
          actor: req.scim,
          ip: req.ip,
        });
        // A page past the end returns no rows, so the window function has
        // nothing to read and `total` used to fall back to 0 — publishing "this
        // tenant has no users" to a directory that reads totalResults to size
        // its sync, while the tenant plainly had users. A known figure reported
        // as zero is the one thing the house rule forbids, so an empty page
        // asks for the count directly rather than guessing it.
        if (q.rows[0]) return { rows: q.rows, total: Number(q.rows[0].total) };
        const counted = await db.query(countSql, countParams);
        return { rows: [], total: Number(counted.rows[0].total) };
      });

      const location = baseLocation(req);
      res.type(CONTENT_TYPE).json({
        schemas: [SCHEMA_LIST],
        totalResults: total,
        startIndex,
        itemsPerPage: rows.length,
        Resources: rows.map((row) => toScimUser(row, location)),
      });
    } catch (err) { next(err); }
  });

  r.get('/Users/:id', async (req, res, next) => {
    try {
      const row = await provisioning.withScimTenant(req.scim.tenantId, async (db) => {
        if (!UUID_RE.test(req.params.id)) return null;
        const q = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.params.id]);
        await provisioning.recordScim(db, {
          tenantId: req.scim.tenantId,
          action: 'scim.user.read',
          subjectId: req.params.id,
          detail: { found: q.rows.length > 0 },
          actor: req.scim,
          ip: req.ip,
        });
        return q.rows[0] || null;
      });
      // A user in another tenant is invisible under the policy, so this is a 404
      // for the same reason a foreign deal is: 403 would confirm the id exists.
      if (!row) { scimError(res, 404, 'No user with that id.'); return; }
      res.type(CONTENT_TYPE).json(toScimUser(row, baseLocation(req)));
    } catch (err) { next(err); }
  });

  r.post('/Users', async (req, res, next) => {
    try {
      const body = req.body || {};
      const email = normaliseUserName(body.userName);
      if (!email) {
        scimError(res, 400, '"userName" is required and must be an email address.', 'invalidValue');
        return;
      }
      // Absent `active` on a create means the directory did not say. A person
      // being provisioned is being given access, so true is the only reading
      // that makes sense of the request at all — but an explicit false is
      // honoured, because a directory that pre-creates disabled accounts means
      // it.
      const active = body.active === undefined ? true : scimBoolean(body.active);
      if (active === null) {
        scimError(res, 400, '"active" must be a boolean.', 'invalidValue');
        return;
      }
      const externalId = typeof body.externalId === 'string' && body.externalId.trim()
        ? body.externalId.trim() : null;

      // CREATE IS THE ONE SCIM OPERATION THAT RUNS ON THE TENANT PATH, under
      // app_user and ordinary tenant row level security, exactly where
      // migration 002 says provisioning belongs. The authentication role
      // deliberately cannot insert a user, and does not need to: a person who
      // does not exist yet has no session to revoke, so this is the one write
      // here that never has to be atomic with `sessions`.
      const row = await withTenant(req.scim.tenantId, null, async (db) => {
        // tenant_id is written from the TOKEN's tenant, and the policy checks
        // it against the transaction's tenant, so a body that carried a tenant
        // could not place a user anywhere in any case.
        const q = await db.query(
          `INSERT INTO users (tenant_id, email, name, scim_external_id, active)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${USER_COLUMNS}`,
          [req.scim.tenantId, email, displayNameFrom(body), externalId, active],
        );
        await provisioning.recordScim(db, {
          tenantId: req.scim.tenantId,
          action: 'scim.user.created',
          subjectId: q.rows[0].id,
          // The email domain and not the address, matching how auth/login.js
          // records a sign-in: the trail shows how the decision was reached
          // without copying personal data into a table with a long retention.
          detail: { domain: email.slice(email.indexOf('@') + 1), active },
          actor: req.scim,
          ip: req.ip,
        });
        return q.rows[0];
      });

      const location = baseLocation(req);
      res.status(201)
        .set('Location', `${location}/Users/${row.id}`)
        .type(CONTENT_TYPE)
        .json(toScimUser(row, location));
    } catch (err) { next(err); }
  });

  /**
   * Replace a user.
   *
   * ONE DEVIATION FROM THE SPEC, AND IT IS DELIBERATE: an absent `active` leaves
   * the current value alone rather than resetting it to the schema default.
   * Strict replace semantics mean a PUT that simply does not mention `active`
   * REACTIVATES someone the directory deactivated — an offboarded analyst
   * silently readmitted by a payload that forgot a field. Reactivating a person
   * is a decision, and it must be one the directory actually asked for.
   */
  r.put('/Users/:id', async (req, res, next) => {
    try {
      const body = req.body || {};
      const email = normaliseUserName(body.userName);
      if (!email) {
        scimError(res, 400, '"userName" is required and must be an email address.', 'invalidValue');
        return;
      }
      const active = body.active === undefined ? undefined : scimBoolean(body.active);
      if (active === null) {
        scimError(res, 400, '"active" must be a boolean or the strings "true"/"false".', 'invalidValue');
        return;
      }
      const patch = {
        email,
        name: displayNameFrom(body),
        scimExternalId: typeof body.externalId === 'string' && body.externalId.trim()
          ? body.externalId.trim() : null,
        ...(active === undefined ? {} : { active }),
      };
      await writeUser(req, res, patch);
    } catch (err) { next(err); }
  });

  r.patch('/Users/:id', async (req, res, next) => {
    try {
      const body = req.body || {};
      // The schemas member is checked when present and not demanded when it is
      // not: some directories omit it, and refusing those requests would mean
      // refusing their deprovisioning.
      if (Array.isArray(body.schemas) && body.schemas.length
          && !body.schemas.includes(SCHEMA_PATCH_OP)) {
        scimError(res, 400, `A PATCH body must use the ${SCHEMA_PATCH_OP} schema.`, 'invalidSyntax');
        return;
      }
      await writeUser(req, res, applyPatch(body.Operations || body.operations));
    } catch (err) { next(err); }
  });

  /**
   * DELETE deactivates. It does not erase.
   *
   * Erasing the row would null out `created_by` on every deal that person
   * underwrote and orphan every audit entry naming them, so "who signed this
   * off" stops having an answer — for a firm whose regulator asks that question
   * about a five-year-old deal, the directory sync is not where that decision
   * gets made. A firm that genuinely wants erasure has an offboarding path that
   * is deliberate, operator-run and irreversible.
   *
   * The security effect is identical to PATCH active=false, which is what
   * matters: sessions are revoked in the same transaction.
   */
  r.delete('/Users/:id', async (req, res, next) => {
    try {
      await writeUser(req, res, { active: false }, { status: 204 });
    } catch (err) { next(err); }
  });

  r.use((req, res) => scimError(res, 404, 'No such SCIM endpoint.'));

  /**
   * SCIM-shaped errors for everything that throws, including a malformed JSON
   * body rejected by the parser before any handler ran. Without this the
   * API-wide handler in app.js answers a directory in a shape it cannot read.
   */
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err instanceof ScimFault) { scimError(res, err.status, err.detail, err.scimType); return; }
    if (err && err.code === '23505') {
      // The unique constraint on (tenant_id, email) reaching this far means a
      // create or a rename collided. `uniqueness` is the scimType directories
      // look for: Okta reacts to it by searching for the existing user and
      // updating that one instead of failing the sync.
      scimError(res, 409, 'A user with that userName already exists in this tenant.', 'uniqueness');
      return;
    }
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      scimError(res, 400, 'The request body is not valid JSON.', 'invalidSyntax');
      return;
    }
    if (err && err.type === 'entity.too.large') {
      scimError(res, 413, 'The request body is too large.');
      return;
    }
    console.error(JSON.stringify({
      level: 'error', msg: err?.message, path: req.path,
      scimToken: req.scim?.tokenId || null, tenant: req.scim?.tenantId || null,
    }));
    // A driver message here would describe the schema to a caller holding one
    // tenant's credential.
    scimError(res, 500, 'The provisioning service could not complete the request.');
  });

  return r;
}

/**
 * Apply a change to one user, revoking sessions in the SAME transaction when
 * the change is a deactivation.
 *
 * THIS FUNCTION IS THE FEATURE. Everything else is plumbing around it.
 */
async function writeUser(req, res, patch, { status = 200 } = {}) {
  const id = req.params.id;

  const outcome = await provisioning.withScimTenant(req.scim.tenantId, async (db) => {
    if (!UUID_RE.test(id)) return { missing: true };

    // FOR UPDATE, so two directory calls racing on the same person cannot
    // interleave a reactivation between a deactivation and its revocations.
    const before = await db.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!before.rows[0]) return { missing: true };
    const reactivating = patch.active === true && before.rows[0].active === false;

    let revoked = 0;
    if (patch.active === false) {
      // REVOKED FIRST, and the order is the point. Both statements are in one
      // transaction so they commit together or not at all; if this is ever
      // split — a refactor, a retry, a connection lost mid-way — the half that
      // has already run is the half that removes access rather than the half
      // that only records an intention to.
      //
      // No tenant predicate, and none is wanted: the restrictive policy in
      // migration 007 scopes `sessions` to this transaction's tenant, so a user
      // id belonging to another firm revokes nothing at all rather than
      // reaching across the boundary.
      const r = await db.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`, [id],
      );
      revoked = r.rowCount;
    }

    const updated = await db.query(
      `UPDATE users
          SET email           = COALESCE($2, email),
              name            = CASE WHEN $3::boolean THEN $4 ELSE name END,
              scim_external_id = CASE WHEN $5::boolean THEN $6 ELSE scim_external_id END,
              active          = COALESCE($7, active),
              -- Cleared on reactivation, because a deactivation date on an
              -- active account reads as "they are gone" to whoever consults it
              -- next.
              deactivated_at  = CASE WHEN $7::boolean IS FALSE THEN now()
                                     WHEN $7::boolean IS TRUE  THEN NULL
                                     ELSE deactivated_at END
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [id,
        patch.email === undefined ? null : patch.email,
        Object.prototype.hasOwnProperty.call(patch, 'name'), patch.name ?? null,
        Object.prototype.hasOwnProperty.call(patch, 'scimExternalId'), patch.scimExternalId ?? null,
        patch.active === undefined ? null : patch.active],
    );

    // Named for what the directory ASKED for, not for what changed. A second
    // deactivation of an already-inactive account is still a deprovisioning
    // instruction, and an investigator reading the trail needs to see that it
    // arrived — `sessionsRevoked: 0` then says there was nothing left to end.
    const action = patch.active === false ? 'scim.user.deactivated'
      : (reactivating ? 'scim.user.reactivated' : 'scim.user.updated');
    await provisioning.recordScim(db, {
      tenantId: req.scim.tenantId,
      action,
      subjectId: id,
      // The revocation count is recorded because it is the question an incident
      // review asks: not "was the account disabled" but "how many live sessions
      // did that actually end".
      detail: {
        attributes: Object.keys(patch),
        ...(patch.active === false ? { sessionsRevoked: revoked } : {}),
      },
      actor: req.scim,
      ip: req.ip,
    });
    return { row: updated.rows[0], revoked };
  });

  if (outcome.missing) { scimError(res, 404, 'No user with that id.'); return; }
  if (status === 204) { res.status(204).end(); return; }
  res.status(status).type(CONTENT_TYPE).json(toScimUser(outcome.row, baseLocation(req)));
}

module.exports = { scimRoutes, __internals: { applyPatch, parseFilter, scimBoolean, __resetRateLimit } };
