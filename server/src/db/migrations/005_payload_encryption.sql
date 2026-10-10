-- ─── Per-tenant envelope encryption for deal payloads ───────────────────────
--
-- `deals.payload` held the underwriting model — purchase price, rent roll,
-- debt terms, the exit assumption — as plaintext JSONB. The volume is
-- encrypted, which protects a stolen disk and nothing else: anyone who reaches
-- the database with a credential reads every firm's deal terms in the clear.
-- A stolen credential is the likelier incident by a wide margin, and it is the
-- one a customer's security questionnaire is actually asking about.
--
-- So: a per-tenant DATA KEY encrypts that tenant's payloads, and a MASTER KEY
-- (AWS KMS in production) wraps the data key. Only the wrapped form is stored
-- here. Reading this database end to end yields, for each tenant, a blob that
-- cannot be opened without a separate call to a service that logs every use.
--
-- The second thing this buys is the ERASURE MECHANISM, and it is the reason
-- migration 006 can offer a right-to-erasure path at all. See the long note in
-- src/admin/retention.js for why crypto-shredding was chosen over the
-- alternative of retaining audit entries under a legitimate-interest basis.

-- ─── Tenant data keys ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_keys (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'local' or 'aws-kms'. Recorded rather than assumed: a row wrapped by one
  -- provider and read by the other must produce a clear error, not a failed
  -- decryption with no explanation. See src/crypto/keyProvider.js.
  provider        text NOT NULL,
  -- A NON-SECRET identifier for the master key that did the wrapping (a KMS key
  -- arn, or a truncated digest of a derived local key). Rotating the master key
  -- without this means every undecryptable row looks identical to corruption.
  master_key_ref  text NOT NULL,
  -- NULL once the key has been destroyed. The tombstone below is what
  -- distinguishes that from "no key has been issued yet" — the two need
  -- opposite handling and must never be confused: one means provision a key,
  -- the other means this tenant's data was deliberately made unrecoverable.
  wrapped_key     bytea,
  created_at      timestamptz NOT NULL DEFAULT now(),
  destroyed_at    timestamptz,
  -- Free text, set by the operator tooling: which ticket, which request.
  destroyed_by    text,
  CONSTRAINT tenant_keys_destroyed_has_no_key
    CHECK ((destroyed_at IS NULL) = (wrapped_key IS NOT NULL))
);

-- Same treatment every tenant-owned table gets in 001: on, FORCED, and one
-- policy. A key row is not deal data, but it is the thing that opens deal data,
-- so it is scoped exactly as tightly.
ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_keys;
CREATE POLICY tenant_isolation ON tenant_keys
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- SELECT and INSERT only, and the omissions are the point:
--
--   no UPDATE  — the application cannot repoint a tenant at a different key,
--                which would make its existing payloads unreadable, nor can it
--                overwrite a key and destroy data through a request path.
--   no DELETE  — crypto-shredding is irreversible. It is an operator action
--                holding the owner credential (src/admin/retention.js), never
--                something reachable from the internet.
--
-- INSERT is granted because a key must exist before a tenant's first deal is
-- written, and requiring an operator to provision one by hand would mean a
-- newly onboarded firm's first save fails. The tenant_keys PRIMARY KEY is what
-- keeps that lazy creation from ever replacing an existing key.
GRANT SELECT, INSERT ON tenant_keys TO app_user;

-- ─── The ciphertext column ───────────────────────────────────────────────────
--
-- A SEPARATE COLUMN, of a different type, rather than storing ciphertext back
-- into `payload`. This is the structural answer to the worst failure mode
-- available here — a read path that hands a caller an encrypted blob as if it
-- were the underwriting model. `payload` is jsonb and `payload_ct` is bytea;
-- there is no code path that can return one believing it is the other, because
-- the route names the column it reads.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS payload_ct bytea;

-- Existing rows are plaintext and stay readable: the read path in
-- src/crypto/keyring.js accepts both shapes, and src/crypto/backfill.js
-- converts them once, per tenant, under the owner credential. Until it has run,
-- a mixed table is the expected state rather than a broken one.
ALTER TABLE deals ALTER COLUMN payload DROP NOT NULL;

-- EXACTLY ONE of the two is set, always. Without this a row could carry both —
-- a backfill that wrote the ciphertext and failed before clearing the
-- plaintext would leave the cleartext sitting next to it, and the encryption
-- claim would be false for rows nobody could distinguish from the rest.
-- Dropped first so the migration is re-runnable.
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_payload_exactly_one_shape;
ALTER TABLE deals ADD CONSTRAINT deals_payload_exactly_one_shape
  CHECK (num_nonnulls(payload, payload_ct) = 1);
