# Read-consistency check

Groundedness checks pointers. It does not check reading. In
`docs/extraction-eval.md`, across three holdouts every wrong answer carried a
grounded citation: the cited cell really did hold the number, but it was the
wrong column. Rosslyn Plaza (holdout2): v2 read 304,000, the square feet
"Under Development or Not Available for Lease", as the total, 989,000.
Easterly (filing5): v1 and v2 read "Leased Square Feet" as size, twelve times.

`src/extraction/readCheck.js` checks the other half. Given the canonical text
(`src/extraction/text.js` format), a field and a citation `{ page, start, end }`,
it decides whether the cited cell sits under a header compatible with the field:

- `consistent`: the aligned column header names the field, and nothing in it
  excludes the field.
- `inconsistent`: the header names something else: a qualifier the field
  excludes ("leased", "under development"), a ratio ("per square foot"), or
  another field's quantity ("% Occupancy" for square feet).
- `indeterminate`: everything it cannot decide. There is no default to
  `consistent`.

`consistent` is not "correct". It says the column is the right kind of column,
nothing about the row or the value.

## How it decides

1. **Locate the cell.** The span must lie inside one cell of one line (cells
   are joined by `" | "`). A line with no cell separator is prose:
   indeterminate. A span across cells or lines: indeterminate.
2. **Find the header.** Walk up from the cited row. Lines with two or more cells
   that carry data values are other rows of the same table and are skipped.
   Short one-cell lines (section labels such as "Other:", page numbers) are
   skipped. A one-cell line of 100 characters or more is prose, and the table
   has ended: indeterminate. The first multi-cell line with no data values is
   the header. Bare years are allowed in a header only as runs of consecutive
   years ("2025 | 2024 | 2023"), which is how a filing heads period columns;
   "1963 | 2007" is data.
3. **Collect titles.** Up to two one-cell lines directly above the header
   ("Square Feet" over "In Service | ... | Total Property") are kept as context.
   A spanned title cannot be aligned to a column, so it is consulted only when
   the column label itself names nothing.
4. **Align the cell.** Equal cell counts align by position. A row longer than
   its header is realigned only by dropping standalone footnote markers
   ("(3)"), and only if dropping all of them makes the counts equal exactly. A
   row shorter than its header has lost an empty cell somewhere (text.js drops
   empty cells), and is never guessed at: indeterminate.
5. **Judge the label** against the field's vocabulary (`VOCABULARY` in
   readCheck.js), in this order: an `excluded` term (ratios, shares, other
   quantities) makes it inconsistent; an `incompatible` qualifier makes it
   inconsistent unless the label offers it as an alternative beside a
   compatible term ("Year Built/ Renovated", "Year Built or Acquired"), which is
   indeterminate; a `compatible` term makes it consistent; another field's
   compatible term makes it inconsistent; then the titles are consulted the
   same way; otherwise indeterminate. For square feet, "In Service" is
   incompatible only when another column of the same header is a total.

The vocabulary is written per field from what the field means. It was not
adjusted per filing or per item to make a case pass, and the cases below that
it misses are reported as missed.

## Measured on the corpus

Frozen extractors (tableReaderV1, tableReaderV2, tableReader v3), the existing
labels, `npm run eval`. Counts are over answered fields (hit, error or
hallucination). "Flagged" is the outcomes of the inconsistent answers.
`inconsistentRate` is inconsistent / (consistent + inconsistent), null when
nothing was checkable. abstainAlways answers nothing (0/0/0, rate null);
guessAlways answers everything without citations, so every answer is
indeterminate (rate null).

| set | extractor | answered | consistent | inconsistent | indeterminate | flagged hit / error / halluc. | wrong answers flagged |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dev | v1 | 64 | 26 | 1 | 37 | 1 / 0 / 0 | no wrong answers |
| dev | v2 | 75 | 26 | 1 | 48 | 1 / 0 / 0 | no wrong answers |
| dev | v3 | 75 | 26 | 1 | 48 | 1 / 0 / 0 | no wrong answers |
| holdout | v1 | 33 | 14 | 0 | 19 | 0 / 0 / 0 | 0 of 1 |
| holdout | v2 | 40 | 14 | 0 | 26 | 0 / 0 / 0 | no wrong answers |
| holdout | v3 | 40 | 14 | 0 | 26 | 0 / 0 / 0 | no wrong answers |
| holdout2 | v1 | 55 | 23 | 1 | 31 | 0 / 1 / 0 | 1 of 1 |
| holdout2 | v2 | 66 | 23 | 1 | 42 | 0 / 1 / 0 | 1 of 1 |
| holdout2 | v3 | 67 | 25 | 0 | 42 | 0 / 0 / 0 | no wrong answers |
| filing5 | v1 | 12 | 0 | 12 | 0 | 0 / 0 / 12 | 12 of 12 |
| filing5 | v2 | 12 | 0 | 12 | 0 | 0 / 0 / 12 | 12 of 12 |
| filing5 | v3 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | rate null: nothing answered |
| filing5 (alternate labels) | v1 | 12 | 0 | 12 | 0 | 12 / 0 / 0 | no wrong answers |
| filing5 (alternate labels) | v2 | 12 | 0 | 12 | 0 | 12 / 0 / 0 | no wrong answers |

The model-based extractor is not in this table: this checkout has no
committed response cache (`eval/predictions/`), so `npm run eval` reports no
model run. When a cache is present the same check runs over its citations with
no further change.

### The two cases it was built for

- **Rosslyn Plaza (holdout2), v1 and v2: flagged.** The row carries a footnote
  cell "(3)" after occupancy, so it has eight cells under a seven-cell header.
  Dropping the one footnote marker makes the counts equal; 304,000 then
  aligns to "Under Development or Not Available for Lease": inconsistent. v3's
  989,000 aligns to "Total Property" under the title "Square Feet":
  consistent. Without the footnote realignment this case is indeterminate,
  not caught.
- **Easterly leased square feet (filing5), v1 and v2: flagged, 12 of 12
  each.** Header "Leased Square Feet": the compatible term "square feet" is
  qualified by "leased", which the field excludes. Under the strict labels
  these are the 12 hallucinations per version. Under the alternate labels the
  same 12 answers are scored as hits, so there the flags count as 12 false
  positives per version. The check takes the strict rule's side, the same
  side as the primary label; it cannot settle the labelling question, and the
  table shows both.

### False positives (correct answers flagged)

Under the primary labels: **3**, one per version, all the same cell.
Federal Realty's Tower Shopping Center (dev): the property type is read from
the property's name cell ("Tower Shopping Center Springfield, VA 22150"),
whose header is "Property, City, State, Zip Code". The vocabulary excludes
city and state for a type, so the read is flagged although the label accepts
the answer. The type is inferred from a name, not read from a type column, so
the flag describes the read accurately; it is still a correct answer flagged.

Under the alternate filing5 labels, 24 more (the Easterly cases above).

No wrong answer was judged `consistent` on any set.

### Misses

- **v1's holdout hallucination, BRT's "1322 North" row (Auburn, AL) read as an address:
  missed (indeterminate).** BRT's row has 15 cells under a 14-cell header (the
  ownership column is headed only on the line above), so the cell is not
  aligned. Had it been, the header "Property Name and Location" names neither
  an address nor anything an address excludes, so it would still be
  indeterminate. A header check cannot tell a name from an address when the
  column holds both.

### Coverage

Across the three versions and the four strict sets, 539 answered fields: 191
consistent, 29 inconsistent, 319 indeterminate. 220 of 539 (41%) were
checkable at all. Why the rest were not:

| reason | count |
| --- | --- |
| row shorter than header (an empty cell was dropped; position lost) | 189 |
| row longer than header, not explained by footnote markers | 71 |
| prose citation | 30 |
| header names neither the field nor anything excluded | 27 |
| header names the field as one of alternatives | 2 |

By filing: Vornado 118 / 2 / 51 (consistent / inconsistent / indeterminate),
Federal Realty 73 / 3 / 0, Easterly 0 / 24 / 0, Plymouth 0 / 0 / 191, BRT
0 / 0 / 77. Plymouth's Item 2 rows omit the "Market" cell except on a
market's first row, so nearly every row is one cell short of its header.
Right-aligning would happen to be correct there; nothing in the text says so,
and the check does not guess. BRT's two-line header and Vornado's Schedule III
(multi-row header) are not aligned either.

By field: squareFeet 79 / 26 / 42, occupancy 39 / 0 / 70, propertyType
42 / 3 / 71, yearBuilt 31 / 0 / 74, address 0 / 0 / 58, purchasePrice
0 / 0 / 4 (every price is a prose citation).

### What this does and does not show

On this corpus every recorded grounded-but-misread answer that had an
alignable header was flagged, and nothing wrong passed as consistent. That is
2 + 24 wrong answers from two layouts, and the vocabulary was written knowing
both cases, so it is evidence that the mechanism works on them, not an
estimate of how it does on the next layout. More than half of answered fields
are indeterminate, and the misses come from exactly the information text.js
throws away (empty cells). The sixth-filing holdout is the first place the
check could be measured on a layout it was not written against.

## In the eval

`npm run eval` prints, per extractor, `read ok/bad/?` (consistent /
inconsistent / indeterminate), `bad-rate` (null when nothing was checkable)
and `flagged hit/err/hall`. `npm run eval -- --json` adds `readConsistency` to
each extractor: the counts, `checked`, `inconsistentRate`, `flagged` and
`passed` (outcomes of the inconsistent and consistent answers), `wrongAnswered`,
`wrongFlagged`, `flagPrecision` (wrong flagged / flagged), `wrongRecall`
(wrong flagged / wrong answered), each ratio null when its denominator is 0,
and `flags`: every inconsistent answer with its item, field, outcome and
header. No other metric or label changed; the printed numbers and the JSON
without `readConsistency` are identical to the run before this change.

## In CI

`.github/workflows/ci.yml` has two jobs for this:

- `extraction-changes` decides whether the eval runs: on the weekly schedule,
  and on a push or pull request whose diff touches `src/extraction/**`,
  `scripts/eval.mjs`, `scripts/mutation-check.py`,
  `corpus/edgar/manifest.json`, or the workflow itself. When no diff can be
  computed (a new branch, a force push) it runs.
- `extraction-eval` restores the fetched filings from the Actions cache (keyed
  on the manifest; filings are immutable), and otherwise fetches them with
  `npm run edgar` per CIK into an empty directory, since the script skips
  anything already in the manifest it writes to, then copies in exactly the
  documents the committed manifest names, failing by name if one is missing.
  `scripts/edgar.mjs` throttles to SEC's request rate. `EDGAR_USER_AGENT` is
  the repository variable of that name when set, otherwise a descriptive
  client name. It then runs `npm run eval` (which re-verifies every label's
  evidence), uploads the JSON report, and runs
  `python3 -I scripts/mutation-check.py`. No model API is called and no key is
  given to the job.

The workflow has not run on GitHub from this branch. Its path decision was
exercised locally against this repository's history, and its copy step against
a partial and a complete fetch directory; the EDGAR fetch itself was not run.

## Tests

`src/extraction/__tests__/readCheck.test.js`. The real fixtures are lines
copied from `htmlToText` over the Vornado, Easterly, Federal Realty, Plymouth
and BRT filings; a final block re-checks that each is a whole line of its
converted filing whenever the corpus is on disk (it is skipped otherwise, and
runs in the CI eval job). Constructed cases are labelled as constructed.
