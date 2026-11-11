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
  the one the extractor got right.

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

## Status

- [x] Schema, comparators and tolerances — `src/extraction/schema.js`
- [x] Scorer, outcomes, rates, calibration, baselines — `src/extraction/score.js`
- [x] Corpus sourcing and the unlabelled guard — `src/extraction/edgar.js`
- [x] Mutation-verified: ten deliberate breaks, ten caught
- [ ] Fetch a corpus (needs `www.sec.gov`, `data.sec.gov`, `efts.sec.gov`
      reachable from the session's environment)
- [ ] Hand-label it against the rules above
- [ ] A first extractor, and a baseline number that beats both degenerates
