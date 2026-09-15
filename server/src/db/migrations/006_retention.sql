-- ─── Retention windows and tenant offboarding ───────────────────────────────
--
-- Deals soft-delete (routes/deals.js sets `deleted_at`) and were never purged,
-- so "delete" meant "hide". That is the right default — an IC memo that cites a
-- deal must still resolve it, and an analyst who deletes the wrong row should be
-- recoverable — but a soft delete with no end is a promise the contract does not
-- make. A customer told us their data was deleted; five years later it is still
-- on disk, in every backup, and in scope for every discovery request.
--
-- There was also no offboarding path at all. See src/admin/retention.js for the
-- design, including which of the two defensible answers to the
-- append-only-audit-log versus right-to-erasure conflict was taken and why the
-- other was rejected.

-- ─── Per-tenant retention window ─────────────────────────────────────────────
--
-- NULL MEANS "NO TENANT-SPECIFIC WINDOW", NOT ZERO AND NOT "NEVER PURGE". The
-- platform default applies, and the CLI reports which of the two produced the
-- number it is about to act on, every time. A retention window is the input to
-- an irreversible deletion; a reader must never have to guess whether a blank
-- meant "the firm negotiated this" or "nobody set it".
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS retention_days integer;

-- Zero would mean "purge the moment a deal is deleted", which removes the
-- recovery window that is the entire reason the delete is soft. If a firm
-- genuinely wants that, it is a conversation, not a value someone can fat-finger
-- into a column. Negative is meaningless. Dropped first so this re-runs.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_retention_days_positive;
ALTER TABLE tenants ADD CONSTRAINT tenants_retention_days_positive
  CHECK (retention_days IS NULL OR retention_days >= 1);

-- ─── Offboarding ─────────────────────────────────────────────────────────────
--
-- Distinct from `status = 'suspended'`, and the distinction matters more than it
-- looks. Suspended means "cannot sign in" — non-payment, a security hold, a
-- contract under review — and is REVERSIBLE. Offboarded means the tenant's data
-- keys have been destroyed and its rows deleted; nothing is coming back. Reading
-- one as the other is how a firm that missed an invoice gets treated as a firm
-- that left.
--
-- The tenant ROW itself is never deleted. `audit_log.tenant_id` references it
-- ON DELETE CASCADE, so dropping the tenant would silently take its entire audit
-- history with it and break the global hash chain from that point on — the exact
-- outcome migration 003 was built to make impossible.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS offboarded_at timestamptz;

-- ─── The purge's index ───────────────────────────────────────────────────────
-- 001 indexes deals for the LIVE path (`WHERE deleted_at IS NULL`), which is the
-- exact complement of what a purge scans. Without this the retention job is a
-- sequential scan of every deal the platform has ever held.
CREATE INDEX IF NOT EXISTS deals_deleted_at_idx ON deals (deleted_at)
  WHERE deleted_at IS NOT NULL;
