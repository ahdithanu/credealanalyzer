# Screening deals against a buy box

A buy box that lives in a document is a buy box you argue yourself out of at
11pm on a deal you like. This turns the criteria into something the tool
enforces, and — more usefully — into something that tells you *which* rule a
deal broke and *by how much*.

```sh
npm run buybox -- deals.json                        # strip centres
npm run buybox -- deals.json --box=small-multifamily
npm run buybox -- deals.json --verbose              # show what passed too
```

## Four verdicts, not two

| | meaning |
|---|---|
| `pass` | every criterion measured and met |
| `review` | a **soft** criterion missed — a conversation, not a no |
| `incomplete` | something material was never measured |
| `fail` | a **hard** criterion missed |

`incomplete` is the one that earns its place. A centre whose rent roll nobody
has keyed in has not passed the tenant-concentration test — it has not taken
it. Scoring that as a pass fills a shortlist with deals whose worst feature is
the one nobody looked at. Every `incomplete` comes with the list of what to go
and find out, ordered hard criteria first.

## Deal record

Only `name` is required. A three-field record is a valid input and returns a
shopping list; that is the intended way to use this at the top of a funnel.

```jsonc
{
  "name": "Maple Crossing",
  "propertyType": "retail",
  "purchasePrice": 2400000,
  "yearBuilt": 1998,

  // Site. Omit what you do not have yet.
  "trafficCount": 22000,        // vehicles per day on the frontage road
  "parkingSpaces": 72,          // counted, not the listing's claim
  "popGrowth3mi": 1.4,          // % over 5 years; negative is the one to walk from
  "anchorStatus": "shadow",     // "shadow" | "unanchored" — carried, not graded

  // Either a rent roll (preferred) or a header building size.
  "buildingSize": 14400,

  "rentRoll": [
    {
      "tenant": "Valley Dental",   // group name: three bays, one operator, one credit
      "category": "medical",
      "squareFeet": 2000,
      "baseRentAnnual": 44000,     // total annual base rent, NOT per SF
      "leaseStart": "2022-01-01",
      "leaseEnd": "2032-01-01",
      "recovery": "nnn",           // "nnn" | "modified" | "gross"
      "marketRentPSF": 23          // your view of market for this bay
    },
    { "vacant": true, "category": "vacant", "squareFeet": 1200 }
  ]
}
```

**The rent roll wins over the header.** If `buildingSize` and the sum of the
bays disagree, the bays are used: a keyed roll is the primary document and the
header is somebody's summary of it.

Tenant categories: `salon`, `medical`, `urgentCare`, `fitness`, `professional`,
`qsr`, `restaurant`, `softGoods`, `generalRetail`, `other`, `vacant`. The first
seven are treated as hard-to-Amazon; `qsr` and `restaurant` both count toward
the restaurant cap.

## Getting a rent roll in

Point the deal at the broker's spreadsheet instead of retyping it:

```jsonc
{ "name": "Maple Crossing", "purchasePrice": 2400000, "rentRollCsv": "./maple-rr.csv" }
```

```sh
npm run buybox -- deals.json     # reads the CSV, screens the deal
npm run buybox -- maple-rr.csv   # a bare rent roll, for the lease criteria only
```

Export the rent roll tab to CSV and pass it as-is. It handles what these
actually look like: a title row before the headers, `$` and thousands
separators, monthly or per-SF rent instead of annual, accounting negatives,
`VACANT` rows, `MTM`, and a `TOTAL` row at the bottom — which is excluded,
because left in it doubles the rent and invents a tenant holding half of it.

Column headers are matched against a synonym list. For a file it cannot read,
map explicitly rather than renaming the broker's file:

```js
parseRentRollCsv(text, { columns: { 'Demised Area': 'squareFeet' } })
```

**Parse problems print above the verdicts, not below.** A verdict computed from
a roll with two unreadable rents is a verdict about a different building:

```
Rent roll did not fully parse
  ! Maple Crossing row 4: an occupied bay with no readable rent. It will be
    excluded from rent totals, concentration and WALT.
```

Nothing unreadable becomes a zero. A bay whose rent read as `0` would make a
fully-let centre look like it has upside, which is the story a buyer wants to
believe.

## Sources that disagree

By the time you write an LOI the same property is described four times — teaser,
OM, rent roll, county assessor — and they do not agree. `mergeListing()` keeps
every field's origin and **records conflicts rather than resolving them**:

```
buildingSize   11,200 (county assessor)   ← leads
               14,000 (flyer)             ← 20% spread
```

Sources rank `measured` > `public` > `document` > `marketing` > `estimate`, and
recency never beats trust: a flyer sent this morning does not outrank an
assessor record from last year, because the flyer was never a measurement.

The ranking decides which value *leads*. It does not decide the others were
wrong — an assessor's gross building area and a rent roll's leasable area are
both correct and differ by the common-area load. 11,200 against 14,000 at
$200/SF is $560k of difference in what you are buying, which is a finding, not
a merge conflict to resolve silently.

Deduplication is by **address**, not name: the same centre is "Maple Crossing",
"Maple Crossing Shopping Center" and "4500 Maple Ave" across three brokers.

## Filling the site criteria from public data

```sh
npm run enrich -- --probe=OH      # FIRST. Confirm the endpoint before trusting it.
npm run enrich -- deals.json      # writes deals.enriched.json
npm run buybox  -- deals.enriched.json
```

Needs `address`, `city` and `state` on the deal. Returns `trafficCount` from
the nearest state DOT count station, `pop3mi` from ACS tracts, and
`popGrowth3mi`.

**Probe first, and mean it.** None of the DOT endpoints in
`src/lib/ingest/dot.js` has ever been called — they are starting points marked
`verified: false`, and every enrichment that uses one says so. State DOT service
URLs move, and a moved ArcGIS service answers a portal page with HTTP 200, which
is why a JSON parse failure on a 200 is reported as `not_json` rather than as a
property with no traffic count. `--probe` prints the endpoint's real field names
so you can confirm the URL and map its columns in one step.

Adding a state is three lines in `DOT_SOURCES`. `aadtFields` is a candidate
list because one state calls it `AADT`, the next `ADT`, the next
`AADT_RPT_QTY` — a near miss still works, and a total miss tells you which
fields did come back.

**The nearest station, with its distance.** ArcGIS returns intersecting
features in no useful order, so the first one is not the closest — in the test
fixture that is 31,000 versus 16,400, the difference between passing your
traffic criterion and not. The distance comes back with the number because on a
signalised corner the two approaches can differ by 40%, and how far away the
measurement was taken is your call.

### Population growth is county-level, and labelled as such

`pop3mi` is a real 3-mile figure: ACS tract populations, for tracts whose
**centroid** falls inside the ring. Intersection alone would count a large
rural tract clipping the edge at its full population, which on a 3-mile ring can
be most of the answer. The centroid method has its own bias — a tract is in or
out whole — and that is the conventional trade for not doing area-weighted
overlap.

`popGrowth3mi` is **county-level**, and the report says so on every run. Two
independent reasons a tract-level 5-year growth is not currently computable:

- **Boundaries.** ACS 5-year products through 2020 are on 2010 census tracts;
  from 2021 they are on 2020 tracts. Differencing 2019 against 2023 for "the
  same tract" compares two different pieces of ground — and in a growing suburb
  the tracts that changed most are exactly the ones that were split *because*
  they grew.
- **Overlap.** The Census Bureau advises against comparing overlapping 5-year
  estimates. The nearest non-overlapping pair on 2020 boundaries needs the 2026
  release. `assertNonOverlapping()` refuses a pair less than five years apart.

So the level is tract-resolution and the growth is county-resolution, with the
county named. A county is not three miles; letting a county number wear a
three-mile label would be the quiet kind of wrong. True 3-mile growth needs the
Census tract relationship files to crosswalk 2010 tracts onto 2020 ones — real
work, not done here.

### The flyer versus the measurement

Enrichment does not overwrite what you supplied. It merges and reports:

```
! trafficCount: 16400 (Ohio DOT 2024) vs 25000 (listing/flyer as supplied) — 34% spread
```

A flyer's 25,000 VPD against a measured 16,400 moves the deal from inside your
traffic criterion to outside it. Both numbers go in front of you.

## What gets measured

Beyond the criteria themselves, the rent roll yields figures worth reading
before you write an LOI:

- **`rolloverByYear`** — how much rent expires in each of the next five years.
  Printed as a warning when 30%+ lands inside 24 months. This is the number
  that should change your mind about a centre that passes everything else;
  WALT is an average and cannot show it.
- **`holdoverSharePct`** — rent on expired leases. Neither contracted term nor
  vacancy, and it disappears inside both.
- **`waltCoverageOfRentPct`** — what share of the rent WALT was computed over.
  A 4.8-year WALT from two of nine leases is not a 4.8-year WALT.
- **`rentVsMarketPct`** — in-place against your market view, over the bays you
  gave one for. Above-market rent looks like income in the OM and resets down.
- **`nnnShareOfRentPct`** — feeds the engine's recovery rate, instead of the
  property-type default of 90%. A centre whose leases are half gross does not
  recover 90%.

## Two things in the criteria that interact

**Two vacant bays only clears the 80% occupancy floor at 10 bays or more.**
Occupancy is measured by area, so with equal-sized bays:

| bays | 1 vacant | 2 vacant |
|---:|---:|---:|
| 5 | 80% | **60%** |
| 8 | 88% | **75%** |
| 9 | 89% | **78%** |
| 10 | 90% | 80% |
| 12 | 92% | 83% |

"One or two vacant bays is the value-add" and "80% occupancy minimum" are both
in the box, and below 10 bays the second one rules out the first. Worth deciding
which you meant before a deal makes you decide it in a hurry.

**Price and price/SF do not line up at the corners**, so they are tested
independently: 25,000 SF at $200/SF is $5M, past the price cap; 8,000 SF at
$100/SF is $800k, under the floor. A deal can sit inside one range and outside
the other, and both are worth knowing.

## What this does not do

It screens. It does not underwrite — no IRR, no DSCR, no monthly schedule.
`engineInputsFromRentRoll()` hands a roll to `runModel()` for that, and the
limit there is worth stating: **the engine escalates one blended rent line.**
It does not know that 38% of the income expires in year two, so it does not
model that rollover, the downtime around it, or the cost of replacing it. Read
`rolloverByYear` alongside the IRR, not instead of it.
