-- One-tap sign-in between SiteVault and AdVault (2026-11-20,
-- lib/signinHandoff, routes/signinHandoff.ts). SiteVault mints a 60 s,
-- single-use HMAC token (prefix "3pl-signin-v1.", purpose "signin-advault")
-- and AdVault's POST /auth/handoff exchanges it for a normal session. This
-- table makes each token single use: its random nonce is inserted once
-- (primary key), a second insert finds the row and the token is refused.
-- Rows are tiny and expire with the token (2 minutes); the exchange deletes
-- expired rows as it goes. No user id is stored, so account deletion has
-- nothing to clean up here.
--
-- Idempotent (IF NOT EXISTS): migrations run at every advault-api start.

CREATE TABLE IF NOT EXISTS signin_handoff_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_signin_handoff_nonces_expires ON signin_handoff_nonces (expires_at);
