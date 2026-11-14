/**
 * Review an uploaded document's extracted fields, one field at a time.
 *
 * Inputs are the shared contracts: a C1 document, C2 predictions, the C3
 * field list and, optionally, other listing sources for the same property.
 * Output is C4 review state, and an explicit "Apply" that hands ONLY the
 * confirmed and edited values to the caller. Nothing applies automatically:
 * a confirm click changes review state and nothing else.
 *
 * Every field is shown, including the ones the extractor did not answer.
 * Each state has exactly one rendering, and none of them is a blank:
 *   grounded     the value, its confidence, and the cited span highlighted in
 *                its surrounding page text, with the page number
 *   ungrounded   the value, with a warning that its quote was not found in
 *                the document (citation null, or one pointing outside the
 *                page text). Shown, never hidden.
 *   abstained    "Not stated in the document", with a manual entry control
 *   unmeasured   a field with no eval behind it carries a visible marker
 *   conflict     every source's value for the field, from mergeListing
 *
 * A document with no text layer gets no form at all: a scanned PDF cannot be
 * extracted from here, and an empty form would read as "nothing was found".
 */

import React, { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import * as schema from '../extraction/schema.js';
import { NA } from '../lib/format';
import { mergeListing } from '../lib/ingest/listing';
import {
  initialReview, confirm, reject, edit, reset, appliedValues, reviewSummary, parseEdit,
} from '../lib/ingest/review';
import {
  LISTING_FIELD_MAP, listingSources, isUnreviewedSourceName,
} from '../lib/ingest/documentSource';

/** C3 fields, read the way the contract says to before PRODUCT_FIELDS lands. */
export function productFields() {
  return schema.PRODUCT_FIELDS ?? schema.FIELDS.map((f) => ({ ...f, label: f.name, measured: true }));
}

/** Characters of page text shown either side of a cited span. */
export const CONTEXT_CHARS = 80;

const fmtNumber = (v) => (typeof v === 'number' && Number.isFinite(v)
  ? v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  : null);

export function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return NA;
  const n = fmtNumber(value);
  switch (field?.kind) {
    case 'money': return n === null ? String(value) : `$${n}`;
    case 'percent': return n === null ? String(value) : `${n}%`;
    case 'area': return n === null ? String(value) : `${n} SF`;
    case 'year': return String(value);
    default: return n ?? String(value);
  }
}

function formatConfidence(c) {
  if (typeof c !== 'number' || !Number.isFinite(c)) return NA;
  return c >= 0 && c <= 1 ? `${Math.round(c * 100)}%` : String(c);
}

/**
 * Resolve a C2 citation against the C1 pages, or say why it cannot be.
 * @returns {{ok:true, page, before, span, after}|{ok:false, reason}}
 */
export function resolveCitation(document, citation) {
  if (!citation) return { ok: false, reason: 'not-found' };
  const { page, start, end } = citation;
  const pages = document?.pages || [];
  if (!Number.isInteger(page) || page < 1 || page > pages.length) return { ok: false, reason: 'out-of-range' };
  const text = pages[page - 1]?.text;
  if (typeof text !== 'string') return { ok: false, reason: 'out-of-range' };
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) {
    return { ok: false, reason: 'out-of-range' };
  }
  const from = Math.max(0, start - CONTEXT_CHARS);
  const to = Math.min(text.length, end + CONTEXT_CHARS);
  return {
    ok: true,
    page,
    before: (from > 0 ? '…' : '') + text.slice(from, start),
    span: text.slice(start, end),
    after: text.slice(end, to) + (to < text.length ? '…' : ''),
  };
}

const INVERSE_MAP = Object.fromEntries(Object.entries(LISTING_FIELD_MAP).map(([k, v]) => [v, k]));

function Citation({ document, prediction }) {
  const c = resolveCitation(document, prediction.citation);
  if (!c.ok) {
    return (
      <div className="notice dr-ungrounded" data-testid="ungrounded">
        <AlertTriangle size={14} />
        <span>
          {c.reason === 'not-found'
            ? 'Ungrounded: the quote for this value was not found in the document. Check it against the source before confirming.'
            : 'Ungrounded: the citation points outside the document text. Check it against the source before confirming.'}
        </span>
      </div>
    );
  }
  return (
    <blockquote className="dr-cite" data-testid="citation">
      <span className="dr-page">Page {c.page}</span>{' '}
      <span>{c.before}</span>
      <mark>{c.span}</mark>
      <span>{c.after}</span>
    </blockquote>
  );
}

function ConflictRows({ conflict }) {
  const rows = [conflict.leading, ...conflict.dissenting];
  return (
    <div className="dr-conflict" data-testid="conflict">
      <div className="notice">
        <AlertTriangle size={14} />
        <span>
          Sources disagree on this field
          {conflict.spreadPct !== null ? ` (spread ${conflict.spreadPct.toFixed(1)}%)` : ''}.
          {conflict.expected ? ` ${conflict.expected}` : ''}
        </span>
      </div>
      <ul>
        {rows.map((r) => (
          <li key={`${r.source}:${String(r.value)}`}>
            <b>{String(r.value)}</b> from {r.source} ({r.kind}
            {isUnreviewedSourceName(r.source) ? ', not yet reviewed' : ''})
            {r === conflict.leading ? ' leads' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FieldRow({ field, document, prediction, entry, conflict, onAction }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);

  const save = () => {
    const parsed = parseEdit(field, draft);
    if (parsed.error) { setError(parsed.error); return; }
    setError(null);
    setEditing(false);
    setDraft('');
    onAction('edit', field.name, parsed.value);
  };

  const editor = (
    <span className="dr-edit">
      <input
        className="inp"
        aria-label={`Value for ${field.label}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="button" className="btn" onClick={save}>Save value</button>
      {error && <span className="dr-error" role="alert">{error}</span>}
    </span>
  );

  return (
    <section className="panel dr-field" data-field={field.name}>
      <div className="panel-hd">
        <b>{field.label}</b>
        {field.unit ? <span className="sub"> ({field.unit})</span> : null}
        {field.measured === false && (
          <span className="chip warn" data-testid="unmeasured">unmeasured: no eval</span>
        )}
        <span className="chip" data-testid="status">{entry ? entry.status : 'no value'}</span>
      </div>
      <div className="panel-bd">
        {prediction ? (
          <>
            <div>
              Extracted: <b data-testid="extracted">{formatValue(field, prediction.value)}</b>
              {' '}· confidence {formatConfidence(prediction.confidence)}
              {prediction.quality === 'estimate' ? ' · the extractor marked this an estimate' : ''}
            </div>
            <Citation document={document} prediction={prediction} />
          </>
        ) : (
          <div data-testid="abstained">Not stated in the document.</div>
        )}

        {entry && entry.status === 'edited' && (
          <div>Reviewer value: <b data-testid="reviewed">{formatValue(field, entry.value)}</b>
            {entry.origin === 'manual' ? ' (entered manually, no citation)' : ''}
          </div>
        )}

        {conflict && <ConflictRows conflict={conflict} />}

        <div className="dr-actions">
          {prediction && (
            <>
              <button type="button" className="btn" onClick={() => onAction('confirm', field.name)}>Confirm</button>
              <button type="button" className="btn" onClick={() => onAction('reject', field.name)}>Reject</button>
            </>
          )}
          {!editing && (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              {prediction ? 'Edit' : 'Enter manually'}
            </button>
          )}
          {editing && editor}
          {entry && entry.status !== 'pending' && (
            <button type="button" className="btn ghost" onClick={() => onAction('reset', field.name)}>Undo</button>
          )}
        </div>
      </div>
    </section>
  );
}

export default function DocumentReview({
  document, predictions = {}, fields: fieldsProp, otherSources = [], initial, onReviewChange, onApply,
}) {
  const fields = fieldsProp ?? productFields();
  const unknown = Object.keys(predictions || {}).filter((n) => !fields.some((f) => f.name === n));
  const noText = document?.textLayer === 'absent';

  const [review, setReview] = useState(() => {
    if (initial) return initial;
    if (noText || unknown.length) return {};
    return initialReview(predictions, fields);
  });

  const merged = useMemo(() => {
    const mine = listingSources(document, predictions, review, { includeUnreviewed: true });
    if (!otherSources.length) return null;
    return mergeListing([...otherSources, ...mine]);
  }, [document, predictions, review, otherSources]);

  const conflictFor = (name) => {
    if (!merged) return null;
    return merged.conflicts.find((c) => INVERSE_MAP[c.field] === name) || null;
  };

  const title = document?.filename ?? 'Document';

  if (!document) {
    return <div className="empty">No document to review.</div>;
  }

  if (noText) {
    return (
      <div className="dr">
        <h2>{title}</h2>
        <div className="notice" data-testid="no-text-layer">
          <AlertTriangle size={14} />
          <span>
            This document has no text layer: it is most likely a scanned PDF. OCR is not
            supported, so no fields can be extracted from it. Enter the figures from the
            document by hand on the deal.
          </span>
        </div>
      </div>
    );
  }

  if (unknown.length) {
    return (
      <div className="dr">
        <h2>{title}</h2>
        <div className="notice" data-testid="unknown-fields">
          <AlertTriangle size={14} />
          <span>
            The extraction names fields this version does not define ({unknown.join(', ')}),
            so it cannot be reviewed here without hiding some of its answers.
          </span>
        </div>
      </div>
    );
  }

  const act = (verb, name, value) => {
    const next = {
      confirm: () => confirm(review, name),
      reject: () => reject(review, name),
      edit: () => edit(review, name, value),
      reset: () => reset(review, name),
    }[verb]();
    setReview(next);
    if (onReviewChange) onReviewChange(next);
  };

  const applied = appliedValues(review);
  const appliedCount = Object.keys(applied).length;
  const summary = reviewSummary(review);

  return (
    <div className="dr">
      <h2>{title}</h2>
      <div className="sub" data-testid="summary">
        {document.pageCount ?? document.pages?.length ?? NA} pages · {summary.pending} pending ·{' '}
        {summary.confirmed} confirmed · {summary.edited} edited · {summary.rejected} rejected
      </div>

      {fields.map((f) => (
        <FieldRow
          key={f.name}
          field={f}
          document={document}
          prediction={predictions[f.name] && predictions[f.name].value !== null && predictions[f.name].value !== undefined
            ? predictions[f.name] : null}
          entry={review[f.name] || null}
          conflict={conflictFor(f.name)}
          onAction={act}
        />
      ))}

      <div className="dr-apply">
        <button
          type="button"
          className="btn primary"
          disabled={appliedCount === 0 || !onApply}
          onClick={() => onApply && onApply(applied, review)}
        >
          Apply {appliedCount} reviewed value{appliedCount === 1 ? '' : 's'}
        </button>
        <span className="sub"> Only confirmed and edited values are applied. Pending and rejected values are not.</span>
      </div>
    </div>
  );
}
