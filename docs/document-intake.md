# Document intake

Upload of PDF documents to a deal, conversion to per-page text, and the API
that serves it (contract C1). Multi-tenant mode only. Nothing is extracted
from the text yet: this track stops at storing it, and a later round wires an
extraction endpoint onto these documents.

## API

All routes are under `/api/deals/:dealId/documents` and need a session.

| Method and path | Who | Returns |
|---|---|---|
| `POST /` | analyst, vp, admin | `201` metadata (C1 without `pages`) |
| `GET /` | any signed-in role | `200 { documents: [metadata, ...] }`, no page text |
| `GET /:docId` | any signed-in role | `200` C1: `{ id, dealId, filename, sha256, byteSize, pageCount, textLayer, pages: [{ page, text }], createdAt }` |

The upload body is the PDF itself with `Content-Type: application/pdf`, not
JSON and not a multipart form. The file name travels URL-encoded in the
`X-Filename` header (a header cannot carry arbitrary Unicode), and the CORS
policy in `server/src/app.js` allows that header. CSRF and Origin checks apply
as on every other mutation.

Client: `api.uploadDocument(dealId, file)`, `api.listDocuments(dealId)` and
`api.getDocument(dealId, docId)` in `src/lib/api.js`. The deal model screen
shows a Documents panel with an upload control, only when `isMultiTenant()`.
In single-user mode there is no panel and no placeholder documents.

## What is stored

Table `deal_documents`, migration `012_deal_documents.sql`:

- `pages_ct`: the per-page text, as a JSON array of `{ page, text }`, sealed
  with AES-256-GCM under the tenant's data key (the same envelope and key as
  `deals.payload_ct`, with the tenant id as additional authenticated data).
- `filename_ct`: the file name, sealed the same way. File names in this
  business are content ("Project Falcon OM, 400 Main St.pdf").
- In the clear: `sha256` of the uploaded bytes, `byte_size`, `page_count`,
  `text_layer` (`present` or `absent`), `uploaded_by`, `created_at`, and the
  `tenant_id` / `deal_id` keys.

Isolation follows the deals table exactly: `apply_tenant_isolation()` from
migration 010 enables and FORCEs row level security, adds `tenant_isolation`
with USING and WITH CHECK, and adds `owner_access` for the migration role.
`app_user` gets SELECT and INSERT only (documents are immutable; there is no
delete route yet).

One addition the deals table did not need: the foreign key to `deals` is
COMPOSITE, `(deal_id, tenant_id)`. Foreign key checks bypass row level
security, so a key on `deal_id` alone would let a tenant attach a row stamped
with its own tenant id to another firm's deal id. The composite key makes the
database refuse that. `deals` gained `UNIQUE (id, tenant_id)` to support it.
`server/test/documents.test.js` asserts the refusal directly.

Every upload writes a `document.uploaded` audit entry with the deal id, byte
size, page count and text layer. It does NOT record the file name: the audit
log is not encrypted and is retained through an offboarding.

## Why the raw PDF is not kept

The original bytes are hashed, parsed and discarded. Reasons:

1. Retention. `server/src/admin/retention.js` can only honestly claim erasure
   for what is sealed under the tenant key. Page text and the file name are
   sealed, so destroying the key covers them with exactly the caveat that
   file states for deal payloads (live systems always; backups only with
   per-tenant KMS keys). A raw PDF stored as a second copy would need the
   same treatment and would put up to 25MB per document into every snapshot,
   WAL segment and replica.
2. Minimisation. A PDF carries far more than its text: embedded images,
   signatures, author and producer metadata, revision history, attachments.
   Nothing downstream uses any of it.
3. There is no object store with lifecycle rules in this deployment, and a
   bytea column is the wrong home for large files.

The cost, stated: the original cannot be viewed or downloaded from the app,
and re-extracting text with a better parser later means the user uploads the
file again. The `sha256` lets a re-upload of the same file to the same deal be
recognised (it is refused with `409 duplicate` and the existing id).

The digest is kept in the clear. It reveals nothing about content to someone
without the file, but anyone holding a copy of a PDF can confirm whether a
tenant uploaded that exact file. That is accepted as the price of duplicate
detection.

Retention and offboarding: documents go with their deal. The retention purge
hard-deletes deals and the foreign key cascades to their documents.
Offboarding deletes the tenant's documents explicitly, counts them in its
report and records `documentsDeleted` in the offboarding audit entry. A
document whose key has been destroyed answers `410 key_destroyed` on read, and
a list shows `filename: null` with `filenameError`, never a placeholder name.

## PDF text

`server/src/documents/pdfText.js`, using `pdfjs-dist` pinned to exactly
`6.4.299` (published 2026-10-03). PDF.js is ESM-only and the server is
CommonJS, so it is loaded with a dynamic `import()` on the first upload.
PDF.js 6 needs Node 22.13 or later, so `server/package.json` engines moved
from `>=20` to `>=22.13.0`; the Dockerfile and CI already run Node 22. npm
also installs PDF.js's optional `@napi-rs/canvas` (a prebuilt native module);
it is used for rendering, which this code never does.

- Text is taken page by page from `getTextContent()`. A line break is written
  where PDF.js marks an end of line (`hasEOL`), and trailing whitespace on each
  line is trimmed. Pages are numbered from 1, so C2 citations index into
  `pages[page - 1].text`.
- `textLayer` is `absent` when no page yields any non-whitespace text, which
  is what a scanned document looks like. Such a document is stored with
  `pageCount` set and every page text `''`. There is no OCR and no text is
  invented.
- The parser runs with `isEvalSupported: false`, no font faces, no system
  fonts and no network fetching. Parsing happens outside any database
  transaction so a large file does not hold a pooled connection.

## Limits and refusals

| Condition | Response |
|---|---|
| Role is not analyst, vp or admin | `403 forbidden` (checked before the body is read) |
| Deal does not exist, is soft-deleted, belongs to another tenant, or the id is malformed | `404 not_found` (never 403) |
| Document id not on this deal, or another tenant's | `404 not_found` |
| `Content-Type` is not `application/pdf` | `415 unsupported_media_type` |
| Body does not start with `%PDF-` (checked on the bytes, not the header or extension) | `415 not_pdf` |
| Empty body | `400 empty` |
| Missing, empty, over 255 characters, or control characters in `X-Filename` | `400 filename_required` |
| Body over 25MB (`25 * 1024 * 1024` bytes) | `413 too_large` with `limitBytes` |
| Password protected | `422 pdf_encrypted` |
| Corrupt or unparseable | `422 pdf_unreadable` |
| More than 2000 pages | `422 pdf_too_many_pages` |
| Same bytes already on this deal | `409 duplicate` with `documentId` |

The 25MB parser is mounted on the upload route only. The global
`express.json({ limit: '1mb' })` is unchanged; a test asserts that a JSON body
over 1MB is still refused on `/api/deals`. Only the last path segment of a file
name is kept.

## Not supported yet

- Extraction from the stored text (no endpoint in this track).
- Deleting or replacing a document; viewing or downloading the original PDF.
- OCR of scanned pages.
- File types other than PDF.
- Documents in the tenant export (`/api/export`).
- A per-route rate limit on uploads beyond the global limiter.
- Documents in single-user mode.

## Tests

- `server/test/documents.test.js` (real Postgres, real HTTP): upload, list,
  get, line breaks, no-text-layer detection, duplicate, cross-tenant 404s,
  malformed ids, reader role denial, CSRF, non-PDF by magic bytes, wrong
  content type, empty body, missing filename, 25MB ceiling, the 1MB JSON limit
  unchanged, encrypted and corrupt PDFs, audit entry contents, sealed at rest
  with no raw bytes, RLS forced, the composite foreign key, CORS header,
  soft-deleted deals, offboarding.
- `server/test/fixtures/pdf.js` builds every test PDF byte by byte. They are
  labelled fixtures, not documents.
- `src/lib/__tests__/documentsApi.test.js` and
  `src/screens/__tests__/dealDocuments.test.jsx` cover the client methods and
  the panel, including that single-user mode renders no panel and sends no
  request.
