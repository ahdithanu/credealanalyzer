# Document review (track 2)

What this round adds: a human review step between an extraction and anything
that uses it, a mapping from a reviewed extraction into the listing merge, and
a screen that shows every field honestly.

Files:

- `src/lib/ingest/review.js`: the C4 review state, as pure functions.
- `src/lib/ingest/documentSource.js`: C1 document + C2 predictions + C4 review
  to listing sources for `src/lib/ingest/listing.js`.
- `src/screens/DocumentReview.jsx`: the review screen.
- `src/App.jsx`: a prop-driven entry point (see "Reachability").
- Tests: `src/lib/__tests__/review.test.js`,
  `src/lib/__tests__/documentSource.test.js`,
  `src/screens/__tests__/documentReview.test.jsx`, with fixtures in
  `src/lib/__tests__/fixtures/reviewFixtures.js`. The fixture document's own
  text says it is a fixture; it is not a real property and not ground truth.

## Review state (C4)

Each entry is `{ status, value, note?, original, origin }`. `status` and
`value` (and `note`) are the C4 contract. Two keys are added, because the task
requires an edit to record the original:

- `original`: the extracted value, or null for a manual entry.
- `origin`: `'extracted'` or `'manual'`.

Rules:

- `initialReview(predictions, fields)` gives every predicted field a pending
  entry. A field the extractor abstained on gets no entry: an abstention is
  "not stated in the document", and a pending null would let a confirm click
  turn an absence into an applied value. A prediction naming a field the field
  list does not define throws, because dropping it would hide an answer.
- `confirm` accepts the extracted value (`original`), even after an edit.
- `reject` keeps the original for the record; it is never applied.
- `edit` requires a value (null, undefined, blank and NaN throw). On an
  abstained field it creates a manual entry with no citation. A manual entry
  cannot be confirmed or rejected; `reset` removes it.
- `reset` returns an extracted field to pending.
- `appliedValues(review)` returns confirmed and edited values only. It is the
  only way a value leaves review.
- `parseEdit(field, raw)` turns typed input into a typed value or an error;
  nothing unreadable is coerced (so a typo is never a zero).

Nothing changes status on its own. Every transition is called from a human
action on the screen, and the screen's Apply button is the only call to
`onApply`.

## Listing mapping

Mapped (extraction name to listing.js name):

| extraction      | listing.js     |
|-----------------|----------------|
| address         | address        |
| squareFeet      | buildingSize   |
| yearBuilt       | yearBuilt      |
| purchasePrice   | purchasePrice  |
| occupancy       | occupancyPct   |

Unmapped, deliberately: `propertyType`, `netOperatingIncome`, `capRate`
(listing.js has no such fields; see `UNMAPPED_REASONS`), and every draft
`PRODUCT_FIELDS` entry. `unmappedFields()` lists them for a given document.

### Do pending values enter the listing?

Decision: not by default, and when they do they are a separate source at a
lower tier.

- Reviewed values (confirmed, edited) form one source at tier `document`,
  which is what listing.js calls an offering memorandum: the seller's
  representation, here checked by a person against the document.
- Pending values form a second source at tier `estimate` ("a house default or
  a model output" in listing.js), only when the caller passes
  `includeUnreviewed: true`. Its `sourceName` ends in
  `(unreviewed extraction)`. listing.js carries `sourceName` and `sourceKind`
  through to provenance and conflicts and drops anything else, so the mark has
  to live in the name to survive the merge.
- Rejected values are in no source.

The review screen asks for unreviewed values so a conflict is visible before
the reviewer decides. Anything that feeds a deal must call `listingSources`
without that flag.

`asOf` is left null. C1's `createdAt` is the upload time and listing.js's
`asOf` is the date the source describes; mixing them would let an old
memorandum outrank a newer one because it was uploaded later.

## The screen

For every field in the field list (C3 read through the contract's fallback,
`productFields()`):

- grounded: value, confidence, page number and the cited span in a `<mark>`
  with 80 characters of page text either side;
- ungrounded (citation null): the value with a warning that its quote was not
  found in the document. A citation outside the page text (bad page, offsets
  past the end, empty span) gets the same treatment with its own wording;
- abstained: "Not stated in the document." with an "Enter manually" control;
- `measured: false`: an "unmeasured: no eval" chip;
- conflicts: when other listing sources are passed, `mergeListing` runs over
  them plus this document's reviewed and unreviewed sources, and each conflict
  is shown with every source's value and kind; unreviewed ones say so;
- `textLayer: 'absent'`: a notice that the document is likely a scanned PDF,
  OCR is not supported and nothing can be extracted. No form is rendered.

Confirm, Reject, Edit / Enter manually and Undo drive C4 state. "Apply N
reviewed values" is disabled until something is confirmed or edited, and calls
`onApply(appliedValues(review), review)`.

## Reachability

There is no extraction endpoint yet (that is a later round), so there is no
real document to show. App therefore takes an optional prop,
`documentReview = { document, predictions, otherSources?, onApply? }`. When it
is given, the rail shows a "Document review" button; when it is not (as
`index.jsx` renders App today), nothing about document review appears. No
sample or fixture document is ever rendered in the app. When the endpoint
lands, whoever fetches C1 and C2 passes them in here; mapping applied values
onto deal inputs is left to that round, since `onApply` is the seam.

## Known gaps

- `vite build` warns that `PRODUCT_FIELDS` is not exported by schema.js. That
  is the contract's fallback doing its job until C3 lands; the build succeeds.
- Review state is held in the screen (and reported via `onReviewChange`); it
  is not persisted. Persisting C4 belongs with the server document routes.
