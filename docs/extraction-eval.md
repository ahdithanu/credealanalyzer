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

**The eval unit is (filing, property), not filing.** The schema describes one
deal; a 10-K describes dozens. The extractor is given the filing's text and the
subject's name as the property table prints it, and answers for that property.

**Subjects are drawn, not chosen.** `sampleSubjects` in `src/extraction/sample.js`
sorts the population by an FNV-1a hash of `entryId|name` and takes a prefix.
The first six per filing are the **dev** set (24 items). The next three are
the **holdout** (12 items). They were drawn and labelled after the extractor
was frozen, and committed before it ran on them. `assertDrawn` refuses a
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

## Status

- [x] Schema, comparators and tolerances — `src/extraction/schema.js`
- [x] Scorer, outcomes, rates, calibration, baselines — `src/extraction/score.js`
- [x] Corpus sourcing and the unlabelled guard — `src/extraction/edgar.js`
- [x] Mutation-verified: ten deliberate breaks, ten caught
- [x] Fetch a corpus: four 10-Ks, office / industrial / multifamily / retail
- [x] Hand-label it: 36 drawn properties, 288 field labels, every stated value evidenced
- [x] Baselines recorded before any extractor
- [x] A first extractor (tableReader) that beats both degenerates on held-out data
- [x] Mutation check covers corpus guards and extractor: 19/19, `scripts/mutation-check.py`
- [ ] v2: the four defects above, scored on a fresh holdout draw
- [ ] A second labeller on a subset, to measure label agreement
- [ ] Real OMs
