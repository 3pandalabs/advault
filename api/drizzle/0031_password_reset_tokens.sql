-- Password reset tokens (2026-11-18). A single-use, 30-minute token for the
-- forgot/reset-password flow. Used for AdVault's own accounts and proxied for
-- SiteVault (the shared login lives here — routes/sitevaultAuth.ts,
-- lib/passwordReset). Only the bcrypt hash is stored; the token handed out is
-- `<id>.<secret>`. Rows are deleted with the account (lib/accountDeletion.ts).
-- Idempotent.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens (user_id);
