/**
 * EDGAR corpus sourcing: the parts that can be tested without a network.
 *
 * The eval corpus is public REIT filings rather than broker offering memoranda,
 * for one reason worth stating plainly: there is no honest way to build a
 * grounding eval out of documents a model wrote. If a model generates the OM
 * and a model extracts from it, the accuracy number measures agreement between
 * two model calls, not whether anything was grounded in a real document. Real
 * filings are worse-matched to the product and genuinely checkable, and that
 * trade goes the right way.
 *
 * What makes 10-K Schedule III ("Real Estate and Accumulated Depreciation")
 * usable as ground truth: it is a per-property table, filed under penalty of
 * law, carrying location, encumbrances, initial cost, costs capitalised
 * subsequent to acquisition, gross carrying amount, accumulated depreciation
 * and date acquired. Those map onto the deal fields in ./schema.js closely
 * enough to score, and a human can check a label against the filing in seconds.
 *
 * WHERE THIS CORPUS IS EASIER THAN A REAL OM, and so where scores against it
 * will be optimistic — this belongs in any writeup of the numbers, not in a
 * footnote nobody reads:
 *
 *   1. Schedule III is a TABLE. An OM states the same facts in marketing prose
 *      spread across forty pages, with the important numbers in a graphic.
 *   2. Filings are internally consistent and audited. An OM routinely contradicts
 *      itself between the summary page and the rent roll.
 *   3. A filing states cost basis, not asking price, and rarely quotes a cap
 *      rate at all. The fields that matter most commercially are the ones this
 *      corpus is thinnest on.
 *   4. No adversarial framing. An OM is a sales document and omits what hurts.
 *
 * Anything measured here is a floor on difficulty, not an estimate of it.
 */

/**
 * SEC asks automated clients to identify themselves and to stay under ten
 * requests a second. Both are conditions of access, so both are honoured here.
 *
 * The default carries no personal contact details. If an operator wants to
 * supply their own, per SEC's fair-access policy, they set EDGAR_USER_AGENT
 * themselves — this code never reaches for an address on its own, because a
 * site asking an automated client for a contact is not a reason to hand over
 * someone's email without being asked.
 */
export const DEFAULT_USER_AGENT = 'credealanalyzer-research/0.1';
export const MIN_REQUEST_INTERVAL_MS = 110; // ~9/sec, inside SEC's limit

/** CIKs are zero-padded to ten digits in submission URLs and bare elsewhere. */
export function padCik(cik) {
  const digits = String(cik).replace(/\D/g, '');
  if (!digits) throw new Error(`not a CIK: ${cik}`);
  if (digits.length > 10) throw new Error(`CIK too long: ${cik}`);
  return digits.padStart(10, '0');
}

export function submissionsUrl(cik) {
  return `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;
}

/**
 * The archive path drops the zero padding on the CIK but keeps the accession
 * number both with dashes (as the document name) and without (as the folder).
 * Getting this wrong 404s, so it is one function with one test rather than
 * string-building at three call sites.
 */
export function filingUrl({ cik, accessionNumber, document }) {
  const bare = String(padCik(cik)).replace(/^0+/, '');
  const folder = String(accessionNumber).replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${bare}/${folder}/${document}`;
}

/**
 * Pull the filings we want out of a submissions document.
 *
 * EDGAR returns recent filings as parallel arrays — `form[i]` describes
 * `accessionNumber[i]` — which is compact and easy to index wrong. This
 * transposes them into records once, so that no caller is ever holding four
 * loose arrays and an index.
 *
 * @param {Object} submissions  parsed data.sec.gov submissions JSON
 * @param {Object} opts
 * @param {string[]} [opts.forms]  form types to keep, default ['10-K']
 * @param {number} [opts.limit]
 */
export function selectFilings(submissions, { forms = ['10-K'], limit = 5 } = {}) {
  const recent = submissions?.filings?.recent;
  if (!recent) return [];

  const {
    form = [], accessionNumber = [], primaryDocument = [],
    reportDate = [], filingDate = [], primaryDocDescription = [],
  } = recent;

  const wanted = new Set(forms.map((f) => f.toUpperCase()));
  const out = [];

  for (let i = 0; i < form.length; i++) {
    if (!wanted.has(String(form[i]).toUpperCase())) continue;
    // A filing with no primary document cannot be fetched; skipping it
    // silently would make `limit` mean something different than it says.
    if (!primaryDocument[i] || !accessionNumber[i]) continue;
    out.push({
      form: form[i],
      accessionNumber: accessionNumber[i],
      document: primaryDocument[i],
      description: primaryDocDescription[i] || null,
      reportDate: reportDate[i] || null,
      filingDate: filingDate[i] || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One corpus entry, as written to the manifest.
 *
 * `groundTruth: null` is the unlabelled state and is deliberately distinct from
 * an empty object. An empty object would mean "a human looked and found no
 * extractable fields", which scores as thirteen correct abstentions; null means
 * nobody has looked yet, and the scorer must refuse to use it.
 */
export function manifestEntry({ cik, company, filing, localPath, fetchedAt }) {
  return {
    id: `${padCik(cik)}-${filing.accessionNumber}`,
    company: company || null,
    cik: padCik(cik),
    form: filing.form,
    accessionNumber: filing.accessionNumber,
    reportDate: filing.reportDate,
    filingDate: filing.filingDate,
    sourceUrl: filingUrl({ cik, accessionNumber: filing.accessionNumber, document: filing.document }),
    localPath,
    fetchedAt,
    groundTruth: null,
  };
}

/**
 * Refuse to score against an unlabelled corpus.
 *
 * Without this the harness would happily report a hallucination rate computed
 * over documents nobody has labelled, where every field reads as "not in the
 * document" and every extraction therefore reads as invention. A number that
 * confident and that wrong is worse than no number, which is the argument this
 * whole directory is built around.
 */
export function assertLabelled(manifest) {
  const unlabelled = manifest.filter((e) => e.groundTruth === null || e.groundTruth === undefined);
  if (unlabelled.length) {
    throw new Error(
      `${unlabelled.length} of ${manifest.length} corpus documents are unlabelled: `
      + `${unlabelled.slice(0, 3).map((e) => e.id).join(', ')}`
      + (unlabelled.length > 3 ? ', ...' : '')
      + '. Label them or filter them out; scoring against them would count every '
      + 'extracted field as a hallucination.',
    );
  }
  return manifest;
}
