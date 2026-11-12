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
    (X + "labels.js", "} else if (!text.includes(ev)) {", "} else if (false) {",
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
    (X + "tableReader.js", "!/leased|per occupied|rent/i.test(label)", "true",
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
]


def run_tests():
    r = subprocess.run(
        ["npx", "vitest", "run", "src/extraction"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode


def main():
    if run_tests() != 0:
        print("baseline: extraction tests already fail; fix them before mutating")
        return 2

    caught = survived = stale = 0
    for path, old, new, what in MUTATIONS:
        f = ROOT / path
        original = f.read_text()
        n = original.count(old)
        if n != 1:
            print(f"STALE     {path}: pattern found {n} times ({what})")
            stale += 1
            continue
        try:
            f.write_text(original.replace(old, new))
            code = run_tests()
        finally:
            f.write_text(original)
        if code != 0:
            caught += 1
            print(f"caught    {what}")
        else:
            survived += 1
            print(f"SURVIVED  {what}  ({path})")

    total = len(MUTATIONS)
    print(f"\n{caught}/{total} caught, {survived} survived, {stale} stale")
    return 0 if caught == total else 1


if __name__ == "__main__":
    sys.exit(main())
