# Market data, and how much of it is real

`src/lib/markets.js` holds thirty-six metros with nine data fields each. It
feeds two things that matter: the property tax rate every deal underwrites
against, and the Market Intelligence scorecard.

**Almost none of it is sourced.** The banner on the Market Intelligence screen
says what the share is, and it is computed from the records rather than typed
in, so it cannot drift away from the truth.

## Three qualities, per field

Provenance is tracked per field, not per record, because a record is not
uniformly anything.

| | meaning |
|---|---|
| `seed` | a plausible number invented for demo ordering |
| `estimate` | defended in its **ordering** against peer markets, and to roughly half a point on level. Good enough to rank; not good enough to cite |
| `sourced` | pulled from a named public dataset, vintage recorded |

A record's `dataQuality` is the **weakest** of its fields. A sourced population
sitting beside an invented cap rate is not a sourced record, and the one flag
every consumer branches on must not say that it is.

## Filling in what can be filled

```sh
npm run markets                  # dry run: what would change, and from where
npm run markets -- --write       # writes src/lib/marketsSourced.js
npm run markets -- --only=columbus-oh
```

Census ACS 5-year estimates at CBSA level give **population**, **median
household income**, and a five-year population CAGR from two non-overlapping
vintages. Free, no key, nationwide.

The other six fields have no free source. Employment growth is BLS and could be
added; supply pipeline, rent growth, traffic counts and cap rates are CoStar,
Yardi, a state DOT and the broker cap rate surveys, and there is no public
substitute for any of them. So **every record still reads `seed` after this
runs**, and that is the design working.

**Check the CBSA names in the dry run.** The codes are from memory and a wrong
one does not fail — it answers with a real metro that is not yours. The report
prints the name the Census returned beside the city the record claims to be, so
"Columbus, GA Metro Area" next to Columbus, OH is visible in a second and
invisible any other way. A 403 on every row means `api.census.gov` is not on
your environment's egress allowlist, not that the request was wrong.

## Two things in the table that will bite

**The tax rate is a commercial rate.** `finance.js` applies it to a commercial
deal, and in half of these states commercial and residential are not the same
number: Indiana caps homestead at 1% of gross assessed value and commercial at
3%; Cook County assesses commercial at 25% of market value against
residential's 10%; Michigan adds 18 mills of school operating levy to
non-homestead property. A residential effective rate — which is what a
published "property tax by metro" table means — understates a strip centre's
tax by a third in those places.

The Texas and Florida rates came from the predecessor application and their
basis is not recorded. Texas assesses every class at market value so the
distinction does not arise there; Florida's Save Our Homes cap applies to
homestead only, so a Florida rate struck on residential data is **low** for
commercial.

**`population` mixes two bases.** It is documented as metro population and for
the primary cities it is, but six records carry city population for what is a
submarket of a larger metro — Plano reads 290,000 against a Dallas–Fort Worth
metro of 7.9M and scores in the bottom decile on Market Scale while being a DFW
submarket. `populationBasis` records which each one is. Sourcing fixes it, by
replacing the city figure with the metro's, which also makes every submarket of
one metro score identically on that feature.

## Adding a market

Three lines in `MIDWEST_MARKETS` or `SUNBELT_MARKETS`, plus a CBSA code in
`src/lib/ingest/acsMarkets.js` — the suite fails if a market has no code, or a
code no market. Add the state to `stateFallbackTaxRate` too if it is new; the
suite checks that as well, because without it a deal in an unlisted city in
that state falls all the way past the state to `DEFAULT_TAX_RATE`, which is a
national placeholder and not an estimate of anywhere.

Adding a market **moves every other market's score**: the scorecard ranks by
percentile within the peer set. Until `dataQuality` reads `sourced`, that means
one set of invented figures is re-ranking another.
