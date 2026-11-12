# Extraction eval

How document extraction is measured, and why it is measured before it is built.

The harness exists ahead of any extractor so that the first number it produces
means something. Code in `src/extraction/`, corpus tooling in `scripts/edgar.mjs`.

## Why public filings and not offering memoranda

There is no honest way to build a grounding eval out of documents a model
wrote. If a model generates the OM and a model extracts from it, the accuracy
number measures agreement between two model calls — not whether anything was
grounded in a real document. That is the same failure as a test suite passing
over a connection that bypasses the policies it claims to test: a measurement
reporting success without observing the thing it names.

So the corpus is real: 10-K **Schedule III — Real Estate and Accumulated
Depreciation**, a per-property table filed under penalty of law, carrying
location, encumbrances, initial cost, costs capitalised subsequent to
acquisition, gross carrying amount, accumulated depreciation and date acquired.
A human can check a label against the filing in seconds.

### Where this corpus is easier than a real OM

Scores here are a **floor on difficulty, not an estimate of it**. State this
alongside any number taken from it:

1. Schedule III is a table. An OM states the same facts in marketing prose over
   forty pages, with the important numbers in a graphic.
2. Filings are internally consistent and audited. An OM routinely contradicts
   itself between the summary page and the rent roll.
3. A filing states cost basis, not asking price, and rarely quotes a cap rate.
   The commercially important fields are the ones this corpus is thinnest on.
4. No adversarial framing. An OM is a sales document and omits what hurts.

Real OMs remain the goal. This corpus is what makes progress measurable in the
meantime.

## Fetching

```sh
npm run edgar -- --cik=899689 --limit=3
npm run edgar -- --cik=899689 --forms=10-K,8-K --limit=5
```

Documents land in `corpus/edgar/` with a `manifest.json`. The documents are
gitignored; the manifest, which carries the labels, is tracked.

SEC asks automated clients to identify themselves and to stay under ten
requests a second. Both are honoured. The default client name carries no
personal contact details — set `EDGAR_USER_AGENT` yourself if you want to send
your own, per SEC's fair-access policy.

Refetching is a no-op: filings are immutable once filed, so anything already in
the manifest is skipped.

Behind an HTTPS proxy, Node's built-in `fetch` ignores `HTTPS_PROXY` unless
told otherwise (Node 22.21+):

```sh
NODE_USE_ENV_PROXY=1 npm run edgar -- --cik=899689 --limit=1
```

Scoring and the self-check:

```sh
npm run eval                          # dev and holdout, baselines beside the extractor
npm run eval -- --set=holdout --json  # machine-readable
python3 -I scripts/mutation-check.py  # break each guard, confirm a test fails
```

`npm run eval` refuses to run unless every filing is labelled, every labelled
subject is the one the draw put there, every field is labelled explicitly, and
every stated value's evidence is in the document and holds the value. It
re-checks all of that on every run, because the documents are refetched and the
converter can change.

## The corpus

| Filing | Genre | Period | Per-property table the subjects are drawn from | Population |
| --- | --- | --- | --- | --- |
| Vornado Realty Trust 10-K | office (NYC) | FY2025 | Item 2, Property Listing | 67 |
| Plymouth Industrial REIT 10-K | industrial | FY2024 (its latest) | Item 2, Company Portfolio | 129 |
| BRT Apartments 10-K | multifamily | FY2025 | Item 1, Our Multi-Family Properties | 31 |
| Federal Realty 10-K | retail | FY2025 | Item 2, Retail and Residential Properties | 113 |
| Easterly Government Properties 10-K (fifth filing, holdout only) | government-leased office, lab, clinic | FY2025 | Item 2, property table | 103 |

**The eval unit is (filing, property), not filing.** The schema describes one
deal; a 10-K describes dozens. The extractor is given the filing's text and the
subject's name as the property table prints it, and answers for that property.

**Subjects are drawn, not chosen.** `sampleSubjects` in `src/extraction/sample.js`
sorts the population by an FNV-1a hash of `entryId|name` and takes a prefix.
The first six per filing are the **dev** set (24 items). The next three are
the **holdout** (12 items). They were drawn and labelled after the extractor
was frozen, and committed before it ran on them. Positions 9 to 13 are
**holdout2** (20 items), drawn and labelled the same way after v2 was frozen.
Once a version's failures on a set have been read, that set is spent: it is
development data for the next version, never evidence about it. `assertDrawn` refuses a
manifest whose labelled subjects differ from the draw. The population lists
live in the manifest so the draw can be recomputed.

**Labels cover the whole filing, not one schedule.** Square feet and occupancy
live in Item 2; construction years mostly in Schedule III; the one stated price
in a subsequent-events note. Labelling Schedule III alone would mark fields
absent that the filing states, and score every correct extraction of them as a
hallucination.

**Every stated value carries evidence**: the verbatim text it was read from,
which `verifyEvidence` checks is in the canonical text and holds the value
(the same literal check the scorer applies to an extractor's citation). Fields
labelled null carry a note saying where the labeller looked and why it is not
stated.

### The canonical text

`htmlToText` in `src/extraction/text.js` is the single rendering that labels,
extractors and citations refer to: one table row per line, non-empty cells
joined by ` | `, `%` glued to its number, `$` and blank cells dropped. The whole
filing is page 1.

Dropping blank cells loses column position, and this matters. In Vornado's
Schedule III, 606 Broadway and 131-135 West 33rd Street each carry one year.
Rendering the filing shows it under **Date acquired**, with Date of
construction blank. The text alone cannot say which column it came from. Those
labels follow the rendered filing (yearBuilt not stated). Two of the 36 items
therefore test the converter as much as the extractor.

## Ground truth

A manifest entry's `groundTruth` is a map of field name to value, and **three
states are distinct**:

| Value | Means |
| --- | --- |
| `null` (the whole `groundTruth`) | Nobody has labelled this document yet. `assertLabelled` refuses to score it. |
| `{}` | A human looked and found no extractable fields. Scores as all correct abstentions. |
| `{ field: null }` | **The document does not state this field.** |
| `{ field: value }` | The document states this field, and this is the value. |

`{ field: null }` is the load-bearing one. Without it you can only ask whether
an answer was right, which a system that invents plausible values for absent
fields still scores well on — because the fields it invents are the ones nobody
checks. It is what makes hallucination measurable at all.

Confusing "unlabelled" with "contains nothing" would count every extracted
field as a hallucination and produce a confident, catastrophic number. That is
why `assertLabelled` throws rather than warns.

## Labelling rules

Judgement calls get decided once, here, rather than drifting between labelling
sessions or getting buried in a comparator where they silently widen matching.

- **Label what the document states, not what is true.** If a filing's square
  footage is stale, the label is the stale figure. The extractor is being
  measured on reading, not on knowing.
- **A derived value is not stated.** If the document gives NOI and price but
  never prints a cap rate, `capRate` is `null`. An extractor may legitimately
  return it as `quality: 'estimate'`; that is not a hallucination, and the
  scorer does not demand a citation for it.
- **Units are points, not fractions.** A 6.25% cap rate labels as `6.25`, never
  `0.0625`. The comparator rejects the fraction deliberately — accepting both
  conventions is how a unit bug reaches production.
- **Addresses are labelled verbatim.** `St` is not normalised to `Street`; the
  comparator does not either. If a genre-wide abbreviation rule is wanted, it
  gets decided here and written down, not added to `normaliseText`.
- **When a document states a field twice and disagrees with itself**, label the
  figure in the primary table and note the conflict on the entry. Do not pick
  the one the extractor got right. The primary table is the per-property table
  the subject was drawn from. If it does not state the field at all (a year
  range, say), the next table that does is used, and the fall-through is noted.

Field by field, as applied to the EDGAR corpus. These were written before the
labels and are what the labels follow:

- **address**: a street address the filing prints for the subject, with a
  building number, verbatim. A property name ("Fourth Street"), a city ("Flushing,
  Queens") or a street with no number ("West Brick Road") is not an address. When
  the same address is printed in two forms ("6575 E 30th Street" in Item 2,
  "6575 East 30th Street" in Schedule III), the primary table's form is the label.
  When the primary cell is a name and another table prints the street address
  ("5855 West Carbonmill Road"), that address is the label.
- **propertyType**: mapped from the type the filing states, through
  `classifyPropertyType` in `schema.js`. Two or more use categories ("Office /
  Retail") map to mixed-use. One use category plus a non-use term ("Retail /
  Theatre") maps to that category. Only a non-use term ("Land") maps to other. A
  type is stated by a type column, by a table heading the row sits under ("Our
  Multi-Family Properties"), or by a type term in the property's own name ("Tower
  Shopping Center"). A portfolio-level sentence ("predominantly retail") states
  nothing about any one property.
- **squareFeet**: the property's size as its table states it. Where a table
  splits in-service from total, the total ("Total Property"). Federal Realty's
  figure is commercial GLA, per its footnote. Units are not square feet.
- **yearBuilt**: one four-digit year. When several are listed ("1911/2009",
  "1948, 1975", "1979 & 2013"), the first, which is original construction
  (Vornado's footnote says so explicitly). When the first is a range
  ("1990-2004"), not stated. "Age 15" is derived and is not a statement of
  yearBuilt. A Schedule III row identified only by city is joined to a subject
  when exactly one property in the filing is in that city. Civic Center I is
  joined by a second hop, through its mortgage amount, and is the most
  disputable label in the corpus.
- **purchasePrice**: a price stated for acquiring that property. Schedule III
  cost basis is not a price. A portfolio price ("4 properties, $100,500") is not
  a property price. Mortgage amounts, refinancings and sale prices are not
  purchase prices.
- **netOperatingIncome**, **capRate**: stated for that property alone. Segment
  or portfolio figures are not.
- **Type codes**: a code in a type column defined by a legend ("SF=Specialized
  Facility") is a stated type, read through the legend. A stated type outside
  the four use categories (clinic, laboratory, courthouse, specialized
  facility, land, studio) is **other**: that is what the enum's other is for.
  The extractors stay pinned to the mapping they were frozen with
  (`classifyPropertyTypeV1`). Extending the labelling vocabulary must not
  change a frozen extractor's answers, and it would have: Federal Realty's
  "Courthouse Center" is a shopping center.
- **Leased square feet is not size.** Where the only per-property figure is
  "Leased Square Feet" (Easterly), squareFeet is not stated, by the same
  logic that keeps "% leased" from being occupancy. This one could
  reasonably go the other way. The label carries `alternateTruth` with the
  leased figure, and `npm run eval` scores the set both ways.
- **Schedule III keyed by city and type code** (Easterly) is joined when the
  pair is unique in both tables, the same rule as a unique city.
- **occupancy**: a figure the filing calls occupancy, for the most recent date
  or period it gives, including an annual average (BRT's "Average Physical
  Occupancy"). **"Percentage leased" is not occupancy** when the filing defines
  it as space "occupied or subject to a lease" (Federal Realty, footnote 3), and
  is labelled null. A cell reading "(5)" (under development) or "—%" states
  nothing.

## Reading the numbers

`scoreCorpus` returns no single headline figure, on purpose. Abstaining on
every field gives a perfect hallucination rate and zero coverage; guessing
every field gives the reverse. Both collapse into a flattering scalar.

| Metric | Denominator | Reads as |
| --- | --- | --- |
| `answerAccuracy` | fields it answered | of what it chose to answer, how often right |
| `coverage` | fields the document contained | of what was there, how much it attempted |
| `hallucinationRate` | fields the document did **not** contain | how often it invented one |
| `groundedness` | answers claiming `quality: 'sourced'` | how often the cited span actually held the value |
| `calibration.ece` | answered fields with a confidence | gap between stated confidence and observed accuracy |

A rate with no denominator returns `null`, never `0`: "nothing to measure"
must never read as "measured, and fine". `groundedness` is `null` when no
document text was supplied, for the same reason.

`BASELINES.abstainAlways` and `BASELINES.guessAlways` are the two degenerate
extractors. A real one has to beat both on their respective weak axis before
any claim about it is meaningful.

### Citations are verified, not believed

An extractor returning `quality: 'sourced'` is making a checkable claim: that
the value appears at the span it cites. `scoreDocument` reads that span out of
the document and reports `grounded: false` when it does not contain the value —
**even when the value is correct**. A right answer behind a fabricated pointer
is a system that will be wrong later and still look sourced.

## Results

First run, tableReader at commit 869c621. Every number below is **a floor on
difficulty, not an estimate**. The four reasons above apply, and these as well:

- **Tiny n.** The holdout is 12 properties: 40 stated fields, 56 absent. The
  intervals are wide (Wilson 95% below), and one labelling decision moves a rate
  by two to three points.
- **Dev is in-sample.** tableReader was written while reading these four
  filings. Dev numbers show it works on what it was built against, nothing more.
  Quote the holdout.
- **The commercial fields are nearly empty.** Across 36 properties, purchase
  price is stated once, NOI and cap rate never. Accuracy and coverage say almost
  nothing about the fields an OM is read for. Only their hallucination rate is
  measured.
- **Address largely echoes the subject.** For properties named by their street
  address, the subject the extractor is given is the answer.
- **One labeller, no second pass.** No inter-annotator agreement has been
  measured. Two labels are flagged as disputable in their notes (Civic Center
  I's joined year, and "3051 Gateway" as an address).

| Set | Extractor | answerAccuracy | coverage | hallucinationRate | groundedness | calibration.ece |
| --- | --- | --- | --- | --- | --- | --- |
| holdout (12) | abstainAlways | null | 0.000 | 0.000 | null | null |
| holdout (12) | guessAlways | 0.050 | 1.000 | 1.000 | null | 0.479 |
| holdout (12) | **tableReader** | **1.000** (32/32; CI 0.89–1.00) | **0.800** (32/40; 0.65–0.90) | **0.018** (1/56; 0.003–0.094) | **1.000** (33/33) | **0.064** |
| dev (24) | abstainAlways | null | 0.000 | 0.000 | null | null |
| dev (24) | guessAlways | 0.065 | 1.000 | 1.000 | null | 0.474 |
| dev (24) | tableReader | 1.000 (64/64) | 0.831 (64/77) | 0.000 (0/115) | 1.000 (64/64) | 0.104 |

tableReader beats both degenerates on their weak axis: coverage 0.800 against
abstainAlways's 0.000, hallucination 0.018 against guessAlways's 1.000.

**What the holdout found:**

- **A grounded hallucination.** For "1322 North —Auburn, AL", tableReader
  returned the property's name as its street address, because it starts with a
  number. The citation is grounded: the span really does hold that string. So
  groundedness was 1.000 alongside a hallucination. A grounded citation shows
  the text exists, not that it was read correctly.
- **A header detector fooled by small numbers.** Outland Center Memphis I's
  construction year was missed. A Schedule III data row whose figures are all
  under 1,000 ("334 | 428 | 2 | …") has no comma-formatted numbers and passed
  as a header, so the real header with "Year Acquired" was never read.
- **The one stated price was missed.** "The venture acquired the property for
  $36,500,000" is prose, and tableReader reads tables.
- **Spanned headers are not aligned.** BRT's occupancy sits under a header that
  spans five year columns, and its type is stated by a heading over the rows.
  Every BRT occupancy and most BRT types are misses, in both sets.

Calibration is low partly by construction. tableReader's confidences are fixed
per rule (0.95, 0.9, 0.85, 0.7), and all 33 holdout answers fall into one
bucket (0.8 to 1.0: mean confidence 0.906, accuracy 0.970). The ECE is one
bucket's gap, mildly underconfident. It is not a calibration curve, and it
does not show the extractor knows when it is wrong: the one wrong answer was
given at 0.95.

These defects are the v2 list. Fixing them against this holdout would spend
it: v2 needs a fresh draw (the next subjects in hash order) labelled before it
is scored.

### v2, on a fresh draw

v2 fixes the four defects above (commit cf32743). It was built against dev and
the v1 holdout, which v1's failures had already spent. Then it was frozen.
Only after the freeze was **holdout2** drawn (positions 9 to 13 per filing:
20 properties, 67 stated fields, 93 absent). It was labelled and committed
(bbef63c) before either version ran on it. v1 is kept byte-for-byte as
`tableReaderV1.js`, so both versions are scored on the same fresh data.

| holdout2 (20) | answerAccuracy | coverage | hallucinationRate | groundedness | calibration.ece |
| --- | --- | --- | --- | --- | --- |
| abstainAlways | null | 0.000 | 0.000 | null | null |
| guessAlways | 0.045 | 1.000 | 1.000 | null | 0.481 |
| tableReader v1 | 0.982 (54/55) | 0.821 (55/67; CI 0.71–0.89) | 0.000 (0/93) | 1.000 | 0.082 |
| **tableReader v2** | **0.985** (65/66; 0.92–1.00) | **0.985** (66/67; 0.92–1.00) | **0.000** (0/93; 0.00–0.04) | **1.000** (66/66) | **0.102** |

Paired on the same fields, v2 gets right 11 that v1 did not and gets wrong
none that v1 got right (exact McNemar p = 0.001). The coverage gain is real.

**Read it narrowly, because:**

- **All 11 gains are in one filing.** They are BRT's spanned occupancy columns,
  its heading-stated type, and its prose price. Holdout2 draws new properties
  from the same four filings, so it shows v2 generalises to new ROWS of table
  layouts it was built on. It says nothing about a fifth filing's layout,
  which is what an OM is. That is now the largest untested assumption.
- **The fix for v1's hallucination is untested on fresh data.** No numbered
  property name with a location suffix was drawn into holdout2. The fix is
  exercised by tests and by the spent sets only.
- **The one error is grounded, again.** Rosslyn Plaza's row carries an extra
  footnote cell after occupancy, which shifts every later cell one column, and
  v2 read 304,000 (square feet under development) as the total, 989,000. The
  citation holds 304,000, so it counts as grounded, at 0.9 confidence. That is
  two holdouts in a row where groundedness was 1.000 beside a wrong answer.
- **The one miss is the disputable label.** Plaza El Segundo's year comes from
  falling through Item 2's range "2006-2007" to Schedule III's "2006/2007/ 2016".
  If that label were null, v2's abstention would be correct.
- **Prices: one of two stated.** Holdout2 has a single stated price (Oaks at
  Victory), and v2 read it. Across all 56 labelled properties the filings state
  two prices, and no NOI or cap rate.
- **Calibration still means little.** 61 of 66 answers sit in the 0.8 to 1.0
  bucket (mean 0.894, accuracy 0.984). The other 5 are heading-derived types at
  0.75, and all are right.

Before freezing, v2 was also swept over the 284 unlabelled subjects outside
every labelled and reserved draw position. It emitted two purchase prices
(Virginia Gateway $215.0 million, Pinole Vista Crossing $60.0 million). Both
were checked by hand as genuine single-property prices. The sweep is not a
score, because nobody labelled those subjects. It is a check that the new
prose reader does not spray prices.

**v3 list:** footnote cells that shift columns (strip a bare "(n)" cell before
aligning); a holdout from a fifth filing whose layout v2 has never seen; a
second labeller on the disputable labels.

### v3 pre-registration: a fifth-filing holdout

Committed before any v3 code is written, and before the fifth filing is
fetched or opened.

- **Development data for v3:** dev, holdout and holdout2, all spent.
- **The fifth filing** is the first of these whose latest 10-K has a
  per-property table of at least 20 rows: Easterly Government Properties
  (CIK 1622194, government-leased office), then Universal Health Realty
  Income Trust (CIK 798783, healthcare), then One Liberty Properties (CIK
  712770, net lease). Eligibility is decided by a script that prints row
  counts, not rows.
- **When:** fetched only after v3 is frozen and committed.
- **Sample:** 12 subjects drawn by `sampleSubjects` from the table's rows,
  labelled under the rules above and committed before v1, v2 or v3 runs on
  them. Where the new layout raises a case the rules do not settle, the
  decision is written into the rules and noted on the label, before scoring.
- **Reported:** all three versions and both baselines on the fifth filing,
  with the full metric set. v3 is not changed after its fifth-filing score is
  seen; anything learned from it is the v4 list.

### v3, on a fifth filing it had never seen

v3 (d37c626) fixes v2's holdout2 error (footnote cells that shift columns),
reads Schedule III through unambiguous shorter names, and knows common header
synonyms. On the spent sets it is near-perfect, which is expected and is not
evidence. The fifth filing, Easterly Government Properties, was
pre-registered (b211833), fetched after the freeze, and labelled and
committed (15c4f25) before any version ran on it.

| fifth filing (12 properties; 21 stated, 75 absent) | answerAccuracy | coverage | hallucinationRate | groundedness | calibration.ece |
| --- | --- | --- | --- | --- | --- |
| abstainAlways | null | 0.000 | 0.000 | null | null |
| guessAlways | 0.000 | 1.000 | 1.000 | null | 0.500 |
| tableReader v1 | null | 0.000 | 0.160 (12/75) | 1.000 | 0.900 |
| tableReader v2 | null | 0.000 | 0.160 (12/75) | 1.000 | 0.900 |
| **tableReader v3** | **null** | **0.000** (0/21; CI 0.00–0.16) | **0.000** (0/75) | **null** | **null** |
| *alternate labels (leased SF counted as size; 33 stated):* | | | | | |
| tableReader v1 / v2 | 1.000 (12/12) | 0.364 (12/33) | 0.000 | 1.000 | 0.100 |
| tableReader v3 | null | 0.000 (0/33) | 0.000 | null | null |

**On a layout it was not built against, v3 reads nothing.** It does not
hallucinate either: it abstains on every field. The 0.985 coverage on
holdout2 measured how well its rules fit four filings' tables, not an ability
to read a property table. This is the result the whole eval exists to
produce, and the earlier numbers should be read in its light.

Why each field was missed:

- **Type (12 misses):** Easterly states types as codes ("SF") defined in a
  legend. No version reads legends.
- **Year (9 misses):** Easterly's Schedule III keys rows by city and type
  code ("Tracy, CA | W"), not by property name. The subject's own row carries
  both ("FEMA - Tracy | Tracy, CA | W"), so a join through the subject row's
  location and code was there to be made. v3's only location join is BRT's
  "Name — City, ST" pattern.
- **Square feet:** the only figure is "Leased Square Feet". v1 and v2 read it
  as size; v3 abstains, because its exclusion list (written for Federal
  Realty's lease-expiry table) includes "leased square".

**On the one field where the versions differ, the score is set by a
labelling convention, not by reading.** Under the strict rule (leased square
feet is not size), v1 and v2 hallucinate 12 times and v3 is clean. Under the
alternate rule, v1 and v2 score 12 hits and v3 has 12 misses. The extractors
did the same thing in both rows. Only the label moved. That is why the
alternate labelling is scored and shown rather than chosen between quietly.

**Groundedness, a third time.** v1 and v2's 12 strict-rule hallucinations
all carry grounded citations: the cell really does hold the number. Across
three holdouts, every wrong or disputed answer has been grounded.
Groundedness checks pointers. It does not check reading, and it must not be
read as a hallucination guard.

**What this means for the product.** A rule-based table reader is a fine
baseline and a poor bet. Each new layout costs a round of rules, and an OM is
always a new layout. The bar for the next extractor, whether model-based or
not, is set here: it must beat zero coverage on the fifth filing without
giving up the zero hallucination rate.

**v4 list** (not applied to v3, per the pre-registration): read type codes
through a legend; join Schedule III through the subject row's own location
and code cells; decide whether the leased-square-feet exclusion belongs in
the extractor or only in the labels; and a model-based extractor scored on
the same five filings, with a sixth filing, pre-registered the same way, as
its holdout.

### Model-based extractor: pre-registration

Committed before the model extractor is written, and before any sixth filing
is fetched.

- **Extractor:** Claude (`claude-opus-5-5`), adaptive thinking, effort
  `high`. The output is a JSON schema per field: a value or null, a verbatim
  quote of the text the value was read from, and a confidence. The quote is
  located in the canonical text by exact match, and its offsets become the
  citation. A quote that is not in the document leaves the citation null,
  which the scorer counts as ungrounded. No answer escapes the grounding
  check by omitting its quote: a non-null value requires one.
- **No refusal fallback.** A fallback would let another model answer and
  have its answer scored as this one's. A refusal is recorded, counted and
  scored as abstention on every field, and the count is reported.
- **Every response is cached** to `eval/predictions/` and committed, so every
  number is reproducible without spending again, and a re-run is a
  deliberate act.
- **Development data:** all five filings (68 properties). The prompt is
  written and revised against them, so the model's numbers there are
  in-sample, like every extractor's.
- **Freeze:** the hash of the prompt and schema is committed as
  `FROZEN_PROMPT_SHA` before the sixth filing is fetched. The runner refuses
  the sixth filing's set under any other hash.
- **The sixth filing** is the first of these whose latest 10-K has a
  per-property table of at least 20 rows, judged by a script that prints row
  counts, not rows: Universal Health Realty Income Trust (CIK 798783,
  healthcare), then One Liberty Properties (CIK 712770, net lease), then Getty
  Realty (CIK 1052752, convenience and automotive retail). Twelve subjects are
  drawn by `sampleSubjects` and labelled under the rules above. The labels are
  committed before any extractor (tableReader v3, the baselines, or the
  model) runs on them. New cases are settled in the rules first.
- **Reported:** the full metric set for every extractor on the sixth filing.
  The model is run there **twice**, because its sampling is not deterministic,
  and both runs are reported. A single run of a stochastic extractor is one
  draw, not a measurement. The prompt is not revised after the sixth filing's
  score is seen.
- **The bar** (from the fifth filing): beat zero coverage on a layout the
  extractor was not developed on, at zero hallucination.

### Model-based extractor: built, not yet run

`src/extraction/modelExtractor.js` builds the request and parses the response,
and makes no network calls. `scripts/extract-model.mjs` sends the requests and
caches each response in `eval/predictions/claude-opus-5-5.json`.
`npm run eval` scores the cache and never calls the API. A model run is scored
on a set only when every item of that set is cached; otherwise it is reported
as not run.

It has not been run. Requests to `api.anthropic.com` need an API key, this
environment has none, and keys for Anthropic's own hosts cannot be stored as
network secrets here. So no number from this extractor exists yet, and none is
quoted. To run it:

1. Add `CREDEALANALYZER_ANTHROPIC_API_KEY` as an environment variable in the
   `credealanalyzer` cloud environment's settings, and start a new session. A
   dedicated name keeps it from changing how anything else authenticates.
2. `npm run extract-model -- --dry-run` prints the estimated cost and calls
   nothing. The estimate at commit time is about $11 for all 68 development
   items and $2 to $4 per holdout run, at list prices.
3. `npm run extract-model` runs the five development filings. Read the
   failures, revise the prompt if warranted, and re-run: a new prompt hash
   starts a new cached run, and old runs stay for comparison.
4. Freeze: set `FROZEN_PROMPT_SHA` to `promptSha()` and commit.
5. Fetch the sixth filing per the pre-registration, label it, and commit.
6. `npm run extract-model -- --set=filing6 --run=run1`, then `--run=run2`,
   then `npm run eval`.

## Status

- [x] Schema, comparators and tolerances — `src/extraction/schema.js`
- [x] Scorer, outcomes, rates, calibration, baselines — `src/extraction/score.js`
- [x] Corpus sourcing and the unlabelled guard — `src/extraction/edgar.js`
- [x] Mutation-verified: ten deliberate breaks, ten caught
- [x] Fetch a corpus: four 10-Ks, office / industrial / multifamily / retail
- [x] Hand-label it: 68 drawn properties across five filings, 544 field labels, every stated value evidenced
- [x] Baselines recorded before any extractor
- [x] A first extractor (tableReader) that beats both degenerates on held-out data
- [x] Mutation check covers corpus guards and extractor: 37/37, `scripts/mutation-check.py`
- [x] v2: the four defects above, scored on a fresh holdout draw (holdout2)
- [x] v3: footnote-cell column shift; scored on a pre-registered fifth filing it had never seen (coverage 0.000)
- [x] Model-based extractor pre-registered (e304b71) and built; mutation-checked
- [ ] Run it: needs `CREDEALANALYZER_ANTHROPIC_API_KEY` in the environment (see above)
- [ ] Freeze its prompt, then the pre-registered sixth filing as its holdout
- [ ] A second labeller on a subset, to measure label agreement
- [ ] Real OMs
