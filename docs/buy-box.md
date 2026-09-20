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
