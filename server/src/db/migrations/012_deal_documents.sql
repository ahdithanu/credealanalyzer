-- ─────────────────────────────────────────────────────────────────────────────
-- Documents attached to a deal: an offering memo, a rent roll, a T-12.
--
-- WHAT IS STORED, AND WHAT IS NOT. The upload route turns the PDF into one
-- text string per page and stores THAT, sealed under the tenant's data key
-- (migration 005), together with the file's name, also sealed. The raw PDF
-- bytes are NOT stored. docs/document-intake.md gives the reasoning; in short,
-- the page text is all any later step uses, and every additional copy of a
-- client's offering memo is one more thing an offboarding has to reach.
--
-- Because both confidential columns are sealed, destroying the tenant key in
-- admin/retention.js makes them unopenable everywhere the key cannot be
-- restored from, the same guarantee (and the same caveat) deals.payload_ct has.
-- What stays in the clear is what is not content: sizes, counts, a digest,
-- timestamps and who uploaded it.
-- ─────────────────────────────────────────────────────────────────────────────

-- deals needs a key covering (id, tenant_id) so the foreign key below can name
-- both columns. Unique on id alone already holds, so this cannot fail on data.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deals_id_tenant_unique') THEN
    ALTER TABLE deals ADD CONSTRAINT deals_id_tenant_unique UNIQUE (id, tenant_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS deal_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_id       uuid NOT NULL,

  -- Sealed (envelope.seal, tenant id as AAD). Filenames are content here:
  -- "Project Falcon OM - 400 Main St.pdf" names the deal and the asset.
  filename_ct   bytea NOT NULL,
  -- Sealed JSON array of { page, text }, one entry per page, in page order.
  pages_ct      bytea NOT NULL,

  -- Digest of the uploaded bytes, hex. Lets a re-upload of the same file to
  -- the same deal be recognised without keeping the file.
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size     integer NOT NULL CHECK (byte_size > 0),
  page_count    integer NOT NULL CHECK (page_count >= 0),
  -- 'absent' means no page yielded any text: a scan. Nothing is OCR'd and no
  -- text is invented for it.
  text_layer    text NOT NULL CHECK (text_layer IN ('present', 'absent')),

  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- THE COMPOSITE FOREIGN KEY IS THE ISOLATION POINT, not tidiness. Foreign
  -- key checks bypass row level security, so a key on deal_id alone would let
  -- a tenant attach a document (stamped with its own tenant_id, which the
  -- policy accepts) to ANOTHER firm's deal id. Naming tenant_id as well means
  -- the referenced deal must belong to the same tenant as the document.
  --
  -- ON DELETE CASCADE so the retention purge and offboarding, which hard-delete
  -- deals, take the deal's documents with them.
  CONSTRAINT deal_documents_deal_fk FOREIGN KEY (deal_id, tenant_id)
    REFERENCES deals (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (deal_id, sha256)
);

CREATE INDEX IF NOT EXISTS deal_documents_deal_idx ON deal_documents (deal_id, created_at);

-- ENABLE + FORCE row level security, tenant_isolation with USING and WITH
-- CHECK, and owner_access for the migration role: migration 010's one call.
SELECT apply_tenant_isolation('deal_documents');

-- SELECT and INSERT only. No UPDATE: a document is immutable once uploaded,
-- and a corrected file is a new upload. No DELETE: there is no delete route
-- yet, and the hard deletes that remove documents (the retention purge and
-- offboarding cascading from deals) run as the owner, not as app_user.
GRANT SELECT, INSERT ON deal_documents TO app_user;
