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

### Population growth is shown and NOT written

Growth is a *difference* between two vintages, and OMB revises CBSA
delineations between them. Differencing ACS 2017 against ACS 2022 for "the same
metro" can compare two different sets of counties, and the answer wears a growth
label while measuring a boundary. From the first real run:

| | 2017 | 2022 | 5-year change |
|---|---:|---:|---:|
| Gainesville, FL | 277,120 | 341,067 | **+23.1%** |
| Corpus Christi, TX | 450,276 | 422,187 | **−6.2%** |
| Des Moines, IA | 623,057 | 711,490 | **+14.2%** |
| Houston, TX (for scale) | 6,636,731 | 7,142,603 | +7.6% |

Gainesville did not add 64,000 people; Levy and Gilchrist counties joined the
CBSA. Corpus Christi did not lose 28,000; Aransas left. Written, 4.24%/yr would
have put Gainesville at the top of the Population Growth percentile across all
thirty-six markets — above Austin — off an artifact.

**And it cannot be detected from the response.** The obvious guard is comparing
the CBSA name across vintages; it does not work. Gainesville is "Gainesville,
FL Metro Area" in both, because a metro keeps its name when a county is added.

So the run prints growth with the two populations behind it and writes nothing.
A change over 10% in five years gets an explicit warning, but **nothing depends
on that flag** — Corpus Christi's −6.2% is under it and is still a boundary
change. No threshold separates a redelineated metro from a genuinely shrinking
one, which is why the refusal is unconditional rather than flag-driven.

The seed value stays. A labelled guess beats a boundary change wearing a
measurement's clothes, because only one of the two is recognisable as wrong.

**The real fix**, which is a genuine piece of work and is not done: take the OMB
delineation file for the latest vintage, read that metro's county list, and sum
county populations over that *fixed* set for both years. County boundaries are
stable, so the comparison then means what it says.

The key rides on the ACS calls only. The geocoder and TIGERweb — used by
`npm run enrich` — do not take one, and are not sent one.

The other six fields have no free source. Employment growth is BLS and could be
added; supply pipeline, rent growth, traffic counts and cap rates are CoStar,
Yardi, a state DOT and the broker cap rate surveys, and there is no public
substitute for any of them. So **every record still reads `seed` after this
runs**, and that is the design working.

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
