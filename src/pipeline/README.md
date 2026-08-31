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
an environment with no outbound network, so `createClient` is fixture-tested
only. First live run should be against a single source with a small geography
before the full plan.
