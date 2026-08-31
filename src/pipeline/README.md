# Market data pipeline

Ingests real market data into the shape `src/lib/markets.js` consumes, replacing
seed values one feature at a time.

## Why a graph, and where it stops

The graph holds **entities and relationships**. The fact store holds
**observations**. That split is the whole design.

Graph-shaped, and not answerable any other way:

- **Ownership.** CRE title runs through layers of single-purpose entities
  precisely so "who owns this" is not answerable from one record. Depth is not
  known in advance, which is what a relational join cannot express.
- **Related-party detection.** A transfer between two SPEs under one holdco is
  not an arm's-length comparable. That exclusion is a graph predicate.
- **Overlapping geography.** A parcel sits in a tract, a submarket, a school
  district, a MUD, a TIF zone, a city and a county. These hierarchies genuinely
  do not nest — and they are where Texas tax rates come from.

Not graph-shaped, and deliberately excluded: population by year, rent by
quarter, assessed value by roll year. Putting time series in a graph is how
graph projects die. Nodes carry an id; the facts hang off it.

## Layers

| Layer | Module | Holds | Rule |
| --- | --- | --- | --- |
| Landing | `stages.land` | Raw payloads, immutable, SHA-256 addressed | Never parsed. A parser bug is a replay, not a re-fetch. |
| Staging | `stages.stage` | Typed, validated records | One source per batch. No cross-source joins. |
| Canonical | `stages.canonicalize` | Entities → `graph`, observations → `facts` | Entity resolution happens here. |
| Serving | `project.projectMarkets` | The app's feature vectors | A projection, not a request-time query. |

Each layer is a pure function of the one before it, so the whole pipeline is
replayable and testable without a network.

## Bitemporality

Every fact carries two clocks: when it was **true** (a 2025 tax roll is valid
for calendar 2025) and when we **learned** it (ingested 3 March 2026).

One clock is not enough. Assessors issue retroactive corrections; a single-clock
store silently rewrites history when one lands, and you can no longer answer
*"what did the model see when the committee approved this deal?"* — which is the
audit trail. `FactStore.get(subject, predicate, { validAt, knownAt })` answers
it; `corrections(since)` lists what changed underneath you.

The store is append-only. A correction is a new fact recorded later over the
same valid period; nothing is mutated or deleted.

## Entity resolution

Deciding that `SUNBELT CAR WASH HOLDINGS LLC`, `Sunbelt Carwash Holdings,
L.L.C.` and `SUNBELT CAR WASH HLDGS LLC` are one entity is the hardest and most
consequential step — every ownership rollup and related-party exclusion
downstream inherits its errors.

`normalise → block → match`, then three-way classification. The **review band is
the design, not a failure mode**: auto-merging the uncertain middle is how you
tell a committee that two unrelated sponsors are the same firm. Blocks larger
than `MAX_BLOCK_SIZE` are dropped and *reported* — a dropped block is
unexamined recall, and an operator needs to see it.

## Provenance

Provenance is **per feature, not per record**. Sourcing lands one feature at a
time, so a market can hold a sourced tax rate next to a seeded supply pipeline,
and the UI must warn about exactly the second one. A seed value is never
silently promoted: with no fact behind it, the seed carries through as
`quality: 'seed'` with the reason attached.

Record-level `dataQuality` is the weakest link — one seeded feature keeps the
whole market marked `partial`, because a reader glancing at a header should not
be reassured by partial sourcing.

## Sources

| Source | Licence | Provides |
| --- | --- | --- |
| Census ACS 5-year | public domain | population, medianHHI, popGrowth5y |
| BLS CES | public domain | employmentGrowth |
| County assessors (HCAD, DCAD) | attribution | effectiveTaxRate, ownership, appraisedValue |
| TxDOT / FDOT AADT | public domain | trafficCount |
| CoStar market analytics | **licensed** | supplyPipeline, marketCapRate, rentGrowth |

Six of nine features are reachable without a subscription. The three that are
not stay seeded and stay flagged; `licensedOnlyFeatures()` names them, and the
default plan still *attempts* the licensed source so the gap is reported on
every run rather than quietly forgotten.

## Outbound HTTP

`transport.js` is the only module that touches the network. Everything upstream
and downstream of it is pure, so this is where the unpleasant properties of the
real world are handled once instead of in each adapter.

| Concern | Why it is here |
| --- | --- |
| **Egress allowlist** | Source URLs come from a registry today, but the moment a county endpoint comes from configuration, an unvalidated fetch is an SSRF. `transportFor(plan)` derives the allowlist from the plan, so it cannot drift out of step with what the pipeline actually calls. https only. |
| **Secret redaction** | Secrets are passed per request, never stored on a descriptor, and scrubbed from every log line and error message — including a provider that echoes your key back in an error body. |
| **Timeouts** | A hung county server must not hold a run open indefinitely. AbortController, reported as a timeout rather than a generic failure. |
| **Conditional requests** | ETag / Last-Modified. An unchanged annual roll costs one 304 instead of re-downloading the file. |
| **Circuit breaker** | Per host. A source that is down fails fast instead of consuming the run's whole retry budget; it half-opens after a cooldown and closes on success. One host being down never trips a healthy one. |
| **Accept modes** | json, text, binary. |
| **Identification** | A `userAgent` with a contact address is mandatory. Anonymous clients get rate-limited or blocked, and an unidentified crawler on a county server is how an IP ends up banned. |

### The four sources genuinely differ

Flattening them to "GET, then `.json()`" breaks three of the four:

| Source | Shape |
| --- | --- |
| Census ACS | GET, json. Key optional as a query parameter below 500 calls/day. |
| BLS CES | Keyless is GET on a single series. With a registration key it is **POST with a JSON body**, and that is the only way to request several series or a year range in one call. |
| HCAD roll | **A zip of pipe-delimited text**, not json. `accept: 'binary'` plus an `unpack` descriptor. |
| TxDOT AADT | GET json, **paginated** via `resultOffset` / `exceededTransferLimit`. |

`buildRequest(sourceId, { params, secrets })` returns the full descriptor;
`runPipeline` follows pagination to exhaustion (bounded, because a provider
whose cursor never terminates would otherwise spin until the bill arrives).

### Archive unpacking

Unzipping needs a real archive reader, and Node has none built in. Rather than
taking a dependency inside the pipeline, `unpackArchive` is injected like
`fetchImpl`:

```js
import unzipper from 'unzipper';   // or adm-zip, yauzl, …

const unpackArchive = async ({ buffer, member }) => {
  const dir = await unzipper.Open.buffer(Buffer.from(buffer));
  const file = dir.files.find((f) => member.test(f.path));
  return (await file.buffer()).toString('utf8');
};
```

A source with an `unpack` descriptor and no `unpackArchive` fails with a message
saying exactly that, rather than handing a zip to a JSON parser.

### Wiring it up

```js
import { runPipeline, defaultPlan, transportFor } from './run';

const plan = defaultPlan({ vintage: 2025, taxYear: 2025 });
const secrets = {
  CENSUS_API_KEY: process.env.CENSUS_API_KEY,
  BLS_API_KEY: process.env.BLS_API_KEY,
};

const client = transportFor(plan, {
  fetchImpl: fetch,
  userAgent: 'cre-deal-analyzer/1.0 (data-ops@yourfirm.com)',
  secrets,
  minIntervalMs: 250,
  timeoutMs: 30_000,
  onEvent: (e) => logger.info(e),      // already redacted
});

const { artifact, report, attributions } = await runPipeline({
  client, plan, secrets, unpackArchive,
  seed: seedMarkets,
  cbsaToMarket: { 26420: 'houston-tx', /* … */ },
  countyToMarket: { hcad: 'houston-tx' },
});
```

`attributions` carries the credit lines the licences require — HCAD data must be
attributed wherever it is shown.

### First live run

Nothing here has touched a live API; it was built without outbound network
access, and every behaviour above is verified against fakes. Go in this order:

1. **Census, one CBSA, no key.** Smallest possible request, public, no auth.
   Confirms the URL shape, the allowlist and json parsing.
2. **Census, all CBSAs, with a key.** Confirms auth injection and that the key
   never appears in a log.
3. **BLS keyless GET, one series.** Then the POST form once a key exists.
4. **TxDOT.** Confirms pagination terminates and page merging is right.
5. **HCAD last.** Largest payload, needs the unpack adapter, and is the one most
   likely to have moved since these URLs were written.

Watch the event stream on the first run of each: a `not-modified` on the second
call proves conditional requests work, and the byte counts tell you whether the
rate limit is set sensibly.

## Running it

Fetching is injected, so the same code path runs against fixtures and against
the network with no branch inside the pipeline.

```js
import { runPipeline, defaultPlan, createClient } from './run';

const client = createClient({ fetchImpl: fetch, minIntervalMs: 250 });
const { artifact, report, graph, resolution } = await runPipeline({
  client,
  plan: defaultPlan({ vintage: 2025, taxYear: 2025 }),
  seed: seedMarkets,
  cbsaToMarket: { 26420: 'houston-tx', /* … */ },
  countyToMarket: { hcad: 'houston-tx' },
  priorPopulation: { 'metro:houston-tx': { value: 6_665_238, years: 5, source: 'census.acs5:2020' } },
});
```

Promoting the output into the app is a separate, explicit step —
`applyMarketData(seed, artifact)` — so it stays reviewable.

Steps are independent: a failing source degrades coverage for the features it
provides and is reported. A pipeline that produces nothing because one county's
file moved is a pipeline nobody runs.

## Status

Every module is unit-tested against fixtures shaped like the real payloads,
including their annoyances: string-typed numbers, ACS suppression sentinels
(`-666666666`), BLS `M13` annual averages that must not be read as a month, and
one legal entity spelled three ways across two counties.

**The HTTP layer has not been exercised against the live APIs.** It was built in
an environment with no outbound network, so the transport is verified against
fakes only: the allowlist, redaction, timeouts, retries, the breaker, conditional
requests and every accept mode have tests, but no request has left the machine.
Follow the ordered first-run sequence above.
