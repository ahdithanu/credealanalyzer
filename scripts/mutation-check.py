#!/usr/bin/env python3
"""Break each guarded behaviour of the extraction eval, confirm a test fails.

    python3 -I scripts/mutation-check.py

A suite that passes is only evidence if it can fail. Each mutation below is a
plausible regression in one guard: the source is edited, the extraction
tests run, and the mutation counts as CAUGHT only if they fail. The original
file is restored whatever happens. Exit status is non-zero if any mutation
survives or any mutation no longer applies (the code moved; update it here
rather than letting a check silently stop checking).
"""

import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
X = "src/extraction/"

# (file, old, new, what the mutation breaks)
MUTATIONS = [
    (X + "text.js", "if ((text === '%' || text === ')' || text === ')%') && cells.length) {",
     "if (false) {", "percent sign stays detached from its number"),
    (X + "text.js", "s = s.replace(/<ix:header\\b[\\s\\S]*?<\\/ix:header>/gi, '');",
     "", "inline XBRL hidden header leaks into the text"),
    (X + "text.js", "if (page !== 1) throw", "if (false) throw",
     "a citation to a non-existent page reads page 1"),
    (X + "sample.js", ".sort((a, b) => a.key - b.key || (a.name < b.name ? -1 : 1))",
     ".sort(() => 0)", "sample follows listing order instead of the hash"),
    (X + "sample.js", "if (new Set(population).size !== population.length) {",
     "if (false) {", "duplicate subjects accepted"),
    (X + "labels.js", "    if (subject !== drawn[i]) {", "    if (false) {",
     "a chosen subject passes as drawn"),
    (X + "labels.js", "if (!has(truth, name)) problems.push", "if (false) problems.push",
     "a field left unlabelled passes as 'not in document'"),
    (X + "labels.js", "else if (v > 0 && v < 1) bad(", "else if (false) bad(",
     "a percentage written as a fraction passes"),
    (X + "labels.js", "    } else if (parts.some((x) => !text.includes(x))) {", "    } else if (false) {",
     "evidence not found in the document passes"),
    (X + "labels.js", "if (kind === 'enum') return classifyPropertyType(evidence) === value;",
     "if (kind === 'enum') return true;", "type evidence is not checked against the mapping"),
    (X + "edgar.js", "return Array.isArray(items) && items.length > 0",
     "return Array.isArray(items)", "an empty subject list counts as labelled"),
    (X + "schema.js", "if (hits.length >= 2) return 'mixed-use';",
     "if (hits.length >= 3) return 'mixed-use';", "two stated uses no longer map to mixed-use"),
    (X + "score.js", "if (fieldName && fieldByName(fieldName).kind === 'enum') {",
     "if (false) {", "enum citations judged literally"),
    (X + "tableReader.js", "if (dates.length !== 2) return;", "if (dates.length < 1) return;",
     "a lone Schedule III date is guessed into a column"),
    (X + "tableReader.js", "const OCC_EXCLUDE = /leased|per occupied|\\brent/i;", "const OCC_EXCLUDE = /(?!)/;",
     "Percentage Leased read as occupancy"),
    (X + "tableReader.js", "if (locRows.length === 1 && subjectRows.length === 1) {",
     "if (locRows.length >= 1) {", "ambiguous location-only rows joined"),
    (X + "tableReader.js", "if (!out[field]) out[field] = answer;", "out[field] = answer;",
     "a later statement (Schedule III) overrides the primary table"),
    (X + "tableReader.js", "const cell = built < acquired ? dates[0] : dates[1];",
     "const cell = dates[0];", "Schedule III date order ignored"),
    (X + "tableReader.js", "const m = String(s).trim().match(/^(\\d{4})(?!\\s*-\\s*\\d)/);",
     "const m = String(s).trim().match(/^(\\d{4})/);", "a year range read as a single year"),
    # v2: one per defect the v1 holdout found, plus the guards added with them
    (X + "tableReader.js", "return !DATA_NUMBER.test(t) && !BARE_NON_YEAR(t) && !NIL.test(t) && c.text.length < 90;",
     "return !DATA_NUMBER.test(t) && c.text.length < 90;", "a data row of small numbers passes as a header"),
    (X + "tableReader.js", "if (/[\u2014\u2013]\\s*[A-Za-z .']+,\\s*[A-Z]{2}\\s*$|,\\s*[A-Z]{2}(\\s+\\d{5})?\\s*$/.test(t)) return false;",
     "", "a name with a trailing location reads as an address"),
    (X + "tableReader.js", "const cell = row.cells[newest + shift];", "const cell = row.cells[newest];",
     "grouped year columns aligned from the left"),
    (X + "tableReader.js", "const newest = run.reduce((a, b) => (Number(P[b].text) > Number(P[a].text) ? b : a));",
     "const newest = run[run.length - 1];", "the oldest year of a run read instead of the newest"),
    (X + "tableReader.js", "if (t === 'mixed-use') return null;", "",
     "a two-category heading types every row in its table"),
    (X + "tableReader.js", "if ((!names_ && !follows) || PLURAL.test(sent.text)) return;",
     "if (!names_ && !follows) return;", "a price for several properties read as the subject's"),
    (X + "tableReader.js", "if (!/[A-Z][\\w'&-]*\\s$/.test(before) && !/^\\s[A-Z]/.test(after)) return true;",
     "return true;", "a name prefix matches inside a longer property name"),
    (X + "schema.js", "    if (Math.abs(n - value) <= Math.abs(value) * 1e-9) return true;", "",
     "a scaled prose figure ($123.5 million) is called ungrounded"),
    # v3
    (X + "tableReader.js", "let excess = (row.cells.length - subjectIdx) - (hcells.length - propIdx);",
     "let excess = 99;", "footnote cells dropped even where they stand in for a value"),
    (X + "tableReader.js", "if (excess > 0 && i > subjectIdx && /^\\(\\d+\\)$/.test(c.text.trim())) { excess--; return; }",
     "", "an extra footnote cell shifts the row's columns"),
    (X + "tableReader.js", "      if (starters.size !== 1) return;", "",
     "an ambiguous shorter name matches another property's row"),
    (X + "tableReader.js", ".replace(/\\s*\\/\\s*/g, '/')", "",
     "spaces round a slash defeat a name match"),
    (X + "tableReader.js", "const SQFT_EXCLUDE = /\\bper\\b|\\brent\\b|", "const SQFT_EXCLUDE = /\\bper\\b|rent|",
     "a Rentable Square Feet column excluded as rent"),
    (X + "tableReader.js", "  return hcells.findIndex((c) => /\\bname\\b|\\bbuilding\\b|\\bfacility\\b|\\basset\\b/i.test(c.text));",
     "  return -1;", "a table that names properties under Name/Building is not read"),
    # fifth-filing harness
    (X + "schema.js", "|\\bclinics?\\b|\\blaborator(?:y|ies)\\b|\\bcourthouses?\\b|\\bspecialized facilit(?:y|ies)\\b/i;", "/i;",
     "a stated type outside the four categories is labelled not stated"),
    (X + "tableReader.js", "import { classifyPropertyTypeV1 as classifyPropertyType } from './schema.js';",
     "import { classifyPropertyType } from './schema.js';", "a frozen extractor follows the labelling vocabulary"),
    (X + "labels.js", "    } else if (parts.some((x) => !text.includes(x))) {", "    } else if (!text.includes(parts[0])) {",
     "a second evidence fragment is not checked against the document"),
    (X + "labels.js", "        alternateTruth: item.alternateTruth || null,", "        alternateTruth: null,",
     "the alternate labelling is silently dropped"),
    # model-based extractor
    (X + "modelExtractor.js", "citation: at >= 0 ? { page: 1, start: at, end: at + quote.length } : null,",
     "citation: { page: 1, start: 0, end: text.length },", "a quote not in the document still yields a citation"),
    (X + "modelExtractor.js", "  if (record.stopReason === 'refusal') {", "  if (false) {",
     "a refusal is not recorded as one"),
    (X + "modelExtractor.js", "  if (record.servedModel && record.servedModel !== MODEL) {", "  if (false) {",
     "another model's answer is scored as this extractor's"),
    (X + "modelExtractor.js", "  if (!FROZEN_PROMPT_SHA) {", "  if (false) {",
     "the holdout runs before the prompt is frozen"),
    (X + "modelExtractor.js", "cache_control: { type: 'ephemeral' } },", "},",
     "the filing is not cached across a filing's properties"),
    # multi-agent build round 1 (intake, review, schema, verify)
    ("server/src/routes/documents.js", "      if (!isPdfMagic(bytes)) {", "      if (false) {",
     "[intake] Removes the magic-byte check, so a non-PDF sent as application/pdf reaches the parser (caught by 'a non-PDF is"),
    ("server/src/db/migrations/012_deal_documents.sql", "FOREIGN KEY (deal_id, tenant_id)\n    REFERENCES deals (id, tenant_id) ON DELETE CASCADE", "FOREIGN KEY (deal_id)\n    REFERENCES deals (id) ON DELETE CASCADE",
     "[intake] Single-column foreign key: a tenant can attach a document stamped with its own tenant id to another firm's dea"),
    ("server/src/documents/pdfText.js", "const textLayer = pages.some((p) => p.text.trim() !== '') ? 'present' : 'absent';", "const textLayer = 'present';",
     "[intake] No-text-layer detection: a scanned PDF would be reported as having text (caught by 'a PDF with no text layer i"),
    ("server/src/routes/documents.js", "r.post('/', requireRole('analyst', 'vp', 'admin'), pdfBody(),", "r.post('/', pdfBody(),",
     "[intake] Role gate on upload: an ic reader could upload (caught by 'a reader (ic) cannot upload but can list and read')"),
    ("server/src/app.js", "'content-type, x-csrf-token, x-filename'", "'content-type, x-csrf-token'",
     "[intake] CORS allow list loses X-Filename, so the cross-origin SPA's upload preflight fails (caught by 'the CORS prefli"),
    ("src/lib/api.js", "      headers: { 'x-filename': encodeURIComponent(file?.name ?? '') },", "      headers: {},",
     "[intake] Client upload no longer sends the file name, so every real upload is a 400 (caught by the 'uploadDocument post"),
    ("src/lib/ingest/review.js", "const APPLIED = new Set(['confirmed', 'edited']);", "const APPLIED = new Set(['confirmed', 'edited', 'pending']);",
     "[review] appliedValues returns pending (unreviewed) values, so extractions reach deal inputs without a human confirming"),
    ("src/lib/ingest/documentSource.js", "if (e && (e.status === 'confirmed' || e.status === 'edited')) values[name] = e.value;", "if (e && e.status !== 'rejected') values[name] = e.value;",
     "[review] pending values enter the reviewed document-tier listing source as if confirmed"),
    ("src/lib/ingest/documentSource.js", "    sourceKind: 'estimate',", "    sourceKind: 'document',",
     "[review] an unreviewed extraction is ranked as a document and outranks a marketing flyer in mergeListing"),
    ("src/screens/DocumentReview.jsx", "start < 0 || end > text.length || start >= end", "start < 0 || end > text.length",
     "[review] an empty citation span is shown as a grounded citation instead of ungrounded"),
    ("src/screens/DocumentReview.jsx", "disabled={appliedCount === 0 || !onApply}", "disabled={!onApply}",
     "[review] Apply is offered before any value has been confirmed or edited"),
    ("src/screens/DocumentReview.jsx", "  if (noText) {", "  if (false) {",
     "[review] a scanned document with no text layer renders an empty form instead of the extraction-not-possible notice"),
    ("src/screens/DocumentReview.jsx", "key={reviewKey(props.document, props.predictions)} ", "",
     "[review] review state survives a document swap, so a value confirmed on document A shows as confirmed on B and Apply se"),
    ("src/screens/DocumentReview.jsx", "\\u0000${JSON.stringify(predictions ?? {})}", "",
     "[review] a new extraction of the same document keeps confirmations made against the previous extraction's values"),
    ("src/extraction/productExtractor.js", "if (holders.length === 1) {", "if (holders.length >= 1) {",
     "[schema] a quote printed on several pages is cited to the first instead of null"),
    ("src/extraction/productExtractor.js", "if (stated && at(stated) >= 0) {", "if (stated) {",
     "[schema] the model's stated page is believed without finding the quote on it"),
    ("src/extraction/productExtractor.js", "if (record.servedModel !== MODEL) {", "if (false) {",
     "[schema] another serving model's answer is accepted as the product extractor's"),
    ("src/lib/ingest/toDealInputs.js", "if (!APPLIED.has(r.status)) {", "if (false) {",
     "[schema] pending or rejected review values reach the deal patch"),
    ("src/lib/ingest/toDealInputs.js", "exTax = v.operatingExpenses - v.realEstateTaxes;", "exTax = v.operatingExpenses;",
     "[schema] property tax charged twice through operatingExpenseRatio"),
    ("src/extraction/schema.js", "&& Math.abs(pred - truth) <= 0.005 + 1e-9,", "&& Math.abs(pred - truth) <= 0.1,",
     "[schema] interest rate comparator widened from half a basis point to 10 bps"),
    ("src/lib/ingest/toDealInputs.js", "(100 * exTax) / (v.grossPotentialRent * occ)", "(100 * exTax) / v.grossPotentialRent",
     "[schema] operatingExpenseRatio struck on GPR alone, so the engine runs with expenses short by the house vacancy (7 test"),
    ("src/extraction/productExtractor.js", "Number.isFinite(c) && c >= 0 && c <= 1;", "Number.isFinite(c);",
     "[schema] a confidence of 1.7 or -0.2 reaches C2 as a probability"),
    ("src/lib/ingest/toDealInputs.js", "&& value === 0) return 'must be greater than zero';", "&& value === 0) return null;",
     "[schema] a confirmed cap rate or interest rate of 0 is written into the deal patch"),
    ("src/extraction/productExtractor.js", "if (Number.isInteger(document.pageCount) && document.pageCount !== document.pages.length) {", "if (false) {",
     "[schema] a document whose pageCount disagrees with its pages is sent to the model"),
    ("src/extraction/readCheck.js", "const kept = rowCells.map((c, i) => i).filter((i) => !FOOTNOTE.test(rowCells[i].text.trim()));", "const kept = rowCells.map((c, i) => i);",
     "[verify] a footnote cell is not realigned past, so Rosslyn's misread goes unflagged"),
    ("src/extraction/readCheck.js", "  return { verdict: READ.INDETERMINATE, reason: `header \"${label}\" names neither", "  return { verdict: READ.CONSISTENT, reason: `header \"${label}\" names neither",
     "[verify] a header naming nothing in the vocabulary reads as consistent by default"),
    ("src/extraction/readCheck.js", "  if (incompatible) return { verdict: READ.INCONSISTENT,", "  if (false) return { verdict: READ.INCONSISTENT,",
     "[verify] Leased Square Feet passes as size"),
    ("src/extraction/readCheck.js", "if (!incompatible && v.whenTotal && siblings.some((s) => TOTAL.test(s))) incompatible", "if (!incompatible && v.whenTotal) incompatible",
     "[verify] In Service is rejected as size even where no total column exists"),
    ("src/extraction/readCheck.js", "if (parts.length > 1 && onlyCompatible && onlyIncompatible) {", "if (false) {",
     "[verify] a header offering alternatives (Year Built/ Renovated) is judged as a mismatch instead of ambiguous"),
    ("src/extraction/readCheck.js", "out.inconsistentRate = checked === 0 ? null : out.inconsistent / checked;", "out.inconsistentRate = checked === 0 ? 0 : out.inconsistent / checked;",
     "[verify] an unchecked set reports an inconsistent rate of 0 instead of null"),
]


def suite_for(path):
    """The suite that can catch a mutation in this file.

    Server mutations need the server's Postgres-backed tests, which need a
    cluster: PGHOST_DIR and PGPORT must be set. Without them a server mutation
    is UNRUN and fails the check. Counting it as caught would be a control
    reporting success without observing anything.
    """
    if path.startswith("server/"):
        if not (os.environ.get("PGHOST_DIR") and os.environ.get("PGPORT")):
            return None
        return (["npm", "test"], ROOT / "server")
    if path.startswith("src/extraction/"):
        return (["npx", "vitest", "run", "src/extraction"], ROOT)
    return (["npx", "vitest", "run"], ROOT)


def run_tests(path="src/extraction/x"):
    suite = suite_for(path)
    if suite is None:
        return None
    cmd, cwd = suite
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return r.returncode


def main():
    if run_tests() != 0 or run_tests("src/x") != 0 or (run_tests("server/x") not in (0, None)):
        print("baseline: tests already fail; fix them before mutating")
        return 2

    caught = survived = stale = unrun = 0
    for path, old, new, what in MUTATIONS:
        f = ROOT / path
        original = f.read_text()
        n = original.count(old)
        if n != 1:
            print(f"STALE     {path}: pattern found {n} times ({what})")
            stale += 1
            continue
        if suite_for(path) is None:
            print(f"UNRUN     {what}  ({path}: set PGHOST_DIR and PGPORT to a running cluster)")
            unrun += 1
            continue
        try:
            f.write_text(original.replace(old, new))
            code = run_tests(path)
        finally:
            f.write_text(original)
        if code != 0:
            caught += 1
            print(f"caught    {what}")
        else:
            survived += 1
            print(f"SURVIVED  {what}  ({path})")

    total = len(MUTATIONS)
    print(f"\n{caught}/{total} caught, {survived} survived, {stale} stale, {unrun} unrun")
    return 0 if caught == total else 1


if __name__ == "__main__":
    sys.exit(main())
