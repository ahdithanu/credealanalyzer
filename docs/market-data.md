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

You need a Census API key. It is free and instant:
[api.census.gov/data/key_signup.html](https://api.census.gov/data/key_signup.html).

```sh
export CENSUS_API_KEY=<the 40 hex characters from the signup email>

npm run markets -- --check-key   # is the key the right shape? no network, no quoting
npm run markets                  # dry run: what would change, and from where
npm run markets -- --write       # writes src/lib/marketsSourced.js
npm run markets -- --only=columbus-oh
```

**Click the activation link in the confirmation email.** The key is rejected
until you do, and a rejected key and a mistyped one look identical from here.
When the Census refuses a key, the script checks its SHAPE — 40 hexadecimal
characters — and says which of the two you have: a well-formed key that is
refused is almost always one that was never activated.

Keep the key out of the repo. It is read from the environment, and every error
message masks it before printing the URL it failed on — a key pasted into a bug
report or a CI log is a key you have to rotate. Surrounding whitespace is
trimmed, because `export CENSUS_API_KEY=$(cat key.txt)`, a heredoc and a .env
line all keep the trailing newline, and untrimmed it encodes to `%0A` and gets
the key rejected.

Without one, the Census answers with an **HTML page carrying HTTP 200**, titled
"Missing Key". That is the shape of failure worth knowing about: unguarded, it
arrives as thirty-six metros that apparently have no population rather than as
thirty-six refused requests. The script names it and stops after the first one
rather than scrolling thirty-six identical errors past you.

Census ACS 5-year estimates at CBSA level give **population** and **median
household income**, nationwide. Both are levels read off a single vintage, so
nothing about them depends on two years being comparable.

### Population growth is summed over a fixed county list

Growth is a *difference* between two vintages, and OMB revises CBSA
delineations between them. Differencing ACS 2017 against ACS 2022 for "the same
metro" can compare two different sets of counties. From the first real run:

| | 2017 | 2022 | 5-year change |
|---|---:|---:|---:|
| Gainesville, FL | 277,120 | 341,067 | **+23.1%** |
| Corpus Christi, TX | 450,276 | 422,187 | **−6.2%** |
| Des Moines, IA | 623,057 | 711,490 | **+14.2%** |
| Houston, TX (for scale) | 6,636,731 | 7,142,603 | +7.6% |

Gainesville did not add 64,000 people; Levy and Gilchrist counties joined the
CBSA. Corpus Christi did not lose 28,000; Aransas left.

**The fix is to stop asking the metro and start asking its counties.** A CBSA is
a union of whole counties, and county boundaries are stable. So: take the county
list from the *latest* delineation, then sum county populations over that same
list in *both* years. A county joining or leaving the metro can no longer read
as people arriving or leaving.

```sh
npm run markets -- --probe-counties            # Columbus, OH by default
npm run markets -- --probe-counties=16980      # any CBSA, nationwide
```

```
TIGERweb layers
  counties  86  Counties
  CBSA      5   Metropolitan Statistical Area/Micropolitan Statistical Area

Columbus, OH Metro Area (CBSA 18140)
  7 counties: Delaware, Fairfield, Franklin, Hocking, Licking, Madison, Perry
  4 bordering counties intersected and were excluded by centroid
```

**Nothing is hardcoded.** The county list is not in the ACS API — CBSA is its own
summary level, not a rung on the state/county hierarchy — and OMB publishes the
delineation as a spreadsheet. So it comes from TIGERweb spatially: fetch the
metro's polygon, fetch the counties that intersect it, keep the ones whose
*centroid* is inside. Intersection alone picks up neighbours that merely share a
border; the centroid test is exact here rather than approximate, because a
county is wholly in or wholly out.

**TIGERweb is many MapServers, split by geography size, and the two layers do
not live in the same one.** The first version looked only in
`TIGERweb/tigerWMS_Current`, and the probe disproved that on the first real
run: that service carries tracts, blocks, places and County *Subdivisions* —
every geography below a county — and neither Counties nor CBSAs. So the search
spans services, ordered likeliest-first, stopping as soon as both layers are
bound and capped so a directory of hundreds does not become hundreds of
requests.

**Names do not identify a layer either.** `Census2020/State_County` offers
**twenty-one layers all called `Counties`** — TIGERweb stacks the same geography
at several vintages and generalisation tiers under identical names, and nothing
in the name, the id or the order says which one carries whole counties at full
detail. So the tie is broken by asking each candidate how many features it
holds: a US counties layer has about 3,143 and a CBSA layer about 935. The
probe prints the count and how many identically-named layers it chose from, so
a binding never reads as more certain than it is.

Layer IDs are discovered by name for the same reason. A stale ID does not
error — it returns a different geography with the same field names, which is
the worst kind of wrong. Binding `Counties` to `County Subdivisions` would
return townships (and that layer is genuinely there, in the service that was
searched first); binding to a `Labels` layer would return annotation geometry.
Both are refused, and an ambiguous match is reported rather than resolved by
taking the first.

**It refuses rather than undercounting.** If any county in the set is missing
from either vintage, no growth is written. Connecticut is the live case: the
2022 ACS replaced its eight counties with nine planning regions on new FIPS
codes, so a current county list finds nothing in 2017. Summing what matched
would drop whole counties from the earlier total and report a population
collapse that never happened — the same class of error, arriving through the fix
instead of the bug.

Multi-state metros work, which is most of what "nationwide" means here: Chicago
is IL-IN-WI, Cincinnati OH-KY-IN, Kansas City MO-KS. County populations are
fetched per state per vintage and cached across the run, so a nine-state pass
costs a handful of calls rather than one per county.

**When the crosswalk cannot be built**, the run falls back to the whole-metro
difference, prints it marked `NOT written`, and writes nothing for growth. The
summary says how many markets fell back. Levels are unaffected either way —
they are read off a single vintage and never needed the county list.

**Nothing sourced means nothing written.** A run where every market failed
leaves the overlay on disk exactly as it was and exits non-zero. It did not
always: the first version rendered `{}` over whatever was there and exited 0,
so an expired key or a Census outage would have silently deleted thirty-six
sourced records and reported success. The file being empty the day that shipped
is the only reason it cost nothing.

**Check the CBSA names in the dry run.** The codes are from memory and a wrong
one does not fail — it answers with a real metro that is not yours. The report
prints the name the Census returned beside the city the record claims to be, so
"Columbus, GA Metro Area" next to Columbus, OH is visible in a second and
invisible any other way. A 403 on every row means `api.census.gov` is not on
your environment's egress allowlist, not that the request was wrong; a "Missing
Key" page on every row means what it says.

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
