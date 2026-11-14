# Product fields: underwriting fields, the product extractor, and the deal patch

This note covers three modules added for the product, and what they do not
claim.

- `src/extraction/schema.js`: `DRAFT_FIELDS`, `PRODUCT_FIELDS` (contract C3),
  `DRAFT_COMPARATORS`, `PRODUCT_COMPARATORS`, `productFieldByName`,
  `productValuesAgree`. Added exports only. `FIELDS`, `COMPARATORS` and the
  classify functions are unchanged.
- `src/extraction/productExtractor.js`: request builder and parser for
  `PRODUCT_FIELDS` over a multi-page uploaded document (contract C1), producing
  contract C2 predictions. Pure: no network calls.
- `src/lib/ingest/toDealInputs.js`: reviewed values (contract C4) to a patch of
  deal-model inputs.

## What is measured, and what is not

**The draft fields have no eval and no measured accuracy.** There are no labels
for them, no corpus of documents that state them, and no score of any
extractor on them. Every draft field carries `measured: false`, and any screen
that shows one must say so.

**The eight `measured: true` fields are measured only under the eval's
conditions**: `modelExtractor.js`'s prompt, on SEC filings, as
`docs/extraction-eval.md` records. The product extractor uses a different
prompt on different documents (offering memoranda and the like). Its accuracy
on those eight fields has not been measured either. `measured: true` means
"an eval exists for this field", not "this prompt has a known accuracy on it".

Nothing here touches the eval. A test (`productFields.test.js`) pins `FIELDS`,
`modelExtractor.js`'s source file and its `promptSha()` to the values computed
on the base commit 05c7411, and checks `COMPARATORS` still holds exactly the six
eval kinds. If one of those tests fails, revert the change; do not update the
constant.

## The draft fields

Chosen from what `src/lib/finance.js` `runModel` reads, plus what an
underwriter needs to convert an offering memorandum figure into one of those
inputs. Dollar flows are annual.

| field | kind | unit | deal input |
|---|---|---|---|
| units | count | units | `units` |
| grossPotentialRent | money | USD/yr | `grossRevenue` |
| operatingExpenses | money | USD/yr | `operatingExpenseRatio` (converted, see below) |
| operatingExpensesIncludeTaxes | enum | includes-taxes / excludes-taxes | none: decides the conversion |
| realEstateTaxes | money | USD/yr | none: used only to take taxes out of expenses |
| askingPrice | money | USD | `purchasePrice` when no purchase price is applied |
| loanAmount | money | USD | none |
| interestRate | rate | % points | `interestRate` |
| amortizationYears | duration | years | `loanTerm` |
| loanTermYears | duration | years | none |
| weightedAverageLeaseTerm | duration | years | none |

The prompt (`SYSTEM_PROMPT` in `productExtractor.js`) defines each one: stated
not derived, current not pro forma, annual not monthly, and null as a correct
answer. Examples of what the definitions rule out: a monthly rent multiplied by
twelve, an expense total added up from line items, a price per unit multiplied
out, a floating rate stated only as a spread, a loan term counted from a
maturity date, a WALT computed from a rent roll.

### Comparators for the new kinds

Written before any eval exists, so that "right" is fixed before a score is seen.

- `count`: exact integer equality. Unit counts are counted, not rounded.
- `rate`: within half a basis point (0.005 points). Note rates are stated
  exactly; 5.125 written as 5.13 agrees, 5.25 against 5.35 does not. A fraction
  (0.0525) never agrees with points.
- `duration`: within 0.05 years. 5.4 against 5.42 agrees; 5.4 against 5.5 does
  not; 120 (months) against 10 (years) does not.

Draft fields of the existing kinds (`money`, `enum`) use the eval's comparators
unchanged. The new comparators live in `DRAFT_COMPARATORS`, not in
`COMPARATORS`, so the eval's object is untouched.

## The product extractor

Conventions carried over from `modelExtractor.js`: model `claude-opus-5-5`,
adaptive thinking, effort high, structured output under a closed JSON schema
(`output_config.format` json_schema, every field required, no additional
properties), no refusal fallback, the document block cached and placed before
the question.

Differences:

- Pages are concatenated with explicit markers, `<page number="N">` and
  `</page>`, and each answer carries a `page` as well as a `quote`.
- A quote is located by exact match **within one page's text**, never in the
  concatenation. If the model's page holds the quote, that page; otherwise the
  single page that holds it; otherwise citation null. So a quote not found, a
  quote that runs across a page boundary (with or without the marker text), and
  a quote printed on several pages that the model's page does not settle all
  give citation null. `unlocatedQuotes` says which and why (`no-quote`,
  `not-found`, `ambiguous`). The value is still returned: an ungrounded value is
  shown as ungrounded, never hidden.
- A value of the wrong type for its kind (a string for a count, an option not
  in the enum) is dropped and listed in `invalidValues`, never coerced.
- A confidence outside 0 to 1 is not a probability and is read as null, never
  clamped.
- `buildRequest` refuses a document with no pages, misnumbered pages, or a
  `pageCount` that disagrees with the pages it carries.
- Known gap, not yet closed: `renderPages` does not escape page text that
  itself contains `</page>`, `<page number=...>` or `</document>`. Citations are
  still checked against the real per-page text, so grounding holds, but such a
  document can mislead the model about page boundaries.
- A record with no serving model recorded is treated like one from another
  model (`served-by:unknown`). `modelExtractor.js` lets a missing model through;
  this one does not.
- Refusal, truncation, unparseable output and another serving model abstain on
  every field and report the error, as `modelExtractor.parseRecord` does.
- Its own hash, `productPromptSha()`, over model, effort, system prompt, schema,
  question templates and page markers. It is computed with a small pure-JS
  SHA-256 (`src/extraction/sha256.js`, tested against `node:crypto`) so the
  parser can be imported in the browser. There is no freeze and no holdout for
  this prompt, because there is no eval for it.

## The deal patch

`toDealInputs(review, deal)` reads only `confirmed` and `edited` values. A pending or
rejected value never reaches the patch, including as one operand of a
conversion. The result is a patch for the caller to apply on a human action,
with `provenance` (which fields and which conversion set each input),
`notApplied`, `invalid`, `incomplete`, `superseded`, `unmapped`, `noValue`
(confirmed or edited with no value) and `assumptions` lists. `assumptions`
holds inputs set by an underwriting choice or from a figure whose definition
may not match the engine's; a UI must show them as such.
Nothing is defaulted and nothing is written as 0: an input without an applied
source value is simply absent from the patch.

Conversions:

- `operatingExpenseRatio` = 100 x (expenses excluding property tax) /
  (gross potential rent x house occupancy). runModel applies the ratio to gross
  potential rent at the firm's house occupancy for the property type (95% for
  multifamily, 90% for office, 93% for retail), so at stabilization its opex
  is GPR x ratio x house occupancy. Dividing by GPR alone would understate the
  document's expenses by the house vacancy; a test runs the patch through
  runModel and checks the stated total comes back. The property type is the
  one the patch sets, else the `deal` argument's; with neither, no ratio is
  written. The engine charges property tax separately, so when the document's
  total includes taxes, `realEstateTaxes` is subtracted first. With no
  `operatingExpensesIncludeTaxes`, no gross potential rent, no property type,
  or taxes larger than the total, no ratio is written and `incomplete` says
  why.
- `grossPotentialRent` maps to `grossRevenue`. For retail, industrial and
  office the engine's `grossRevenue` is base rent only, with reimbursements
  modelled through `expenseRecoveryRate`; the prompt does not tell the model to
  exclude recoveries, so for those types the mapping is listed in
  `assumptions` for the reviewer to check.
- With no applied `purchasePrice`, an `askingPrice` is used as the purchase
  price and listed in `assumptions`: that is an underwriting choice, not a unit
  conversion.
- A contract `purchasePrice` supersedes an `askingPrice`; the ask is reported in
  `superseded`, not averaged.
- `propertyType` maps only to the engine's types (multifamily, office, retail,
  industrial). mixed-use and other are reported unmapped.
- Rates in (0, 1) are rejected as fractions written where percentage points
  belong. An interest rate or cap rate of exactly 0 is rejected, as is any rate
  or percent outside 0 to 100.

Fields with no deal input (`NO_DEAL_INPUT`), each with its reason in the code:
address, yearBuilt, netOperatingIncome, occupancy, realEstateTaxes,
operatingExpensesIncludeTaxes, loanAmount, loanTermYears,
weightedAverageLeaseTerm. Two are worth stating here. Occupancy is not copied
into `vacancyRate`, because in-place occupancy is a fact and the vacancy rate is
the firm's stabilized underwriting assumption. Loan amount is not converted to
`downPayment`, because the engine sizes the loan on total project cost, which
an offering memorandum does not state.

Caveat for NNN property types: the engine's `grossRevenue` is base rent only,
with reimbursements modelled through `expenseRecoveryRate`. A gross potential
rent figure that includes reimbursements would double them; the prompt asks for
rent, but a reviewer confirming the value should check.
