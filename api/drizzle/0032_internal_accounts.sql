-- Internal accounts (2026-11-18). 3PandaLabs runs ads for its own apps
-- (SiteVault, RsvpVault, AdVault itself) through AdVault as normal,
-- full-price customers. They pay real prices and launch for real; the flag
-- only keeps their money out of revenue / traction numbers and tags Stripe
-- (`internal=1`), ops alerts, the Google account and the Mercury card
-- ("INTERNAL · "). Set by a real admin (POST /admin/internal-accounts).
--   users.is_internal     true for an org-owned account; default false.
--   users.internal_label  which product it advertises ("SiteVault"), or NULL.
-- Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS internal_label text;

CREATE INDEX IF NOT EXISTS users_is_internal_idx ON users (id) WHERE is_internal;
