-- Self-service account deletion, 2026-11-13 (Google Play requires it in-app).
--
-- The user row is anonymised and kept, never deleted: payments, purchases,
-- invoices and the wallet ledger cascade from it, and those are the financial
-- records we must keep. deleted_at marks the tombstone; see
-- lib/accountDeletion.ts.
--
-- Idempotent: runs at every API container start.

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
