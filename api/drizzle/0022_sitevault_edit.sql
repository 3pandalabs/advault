-- One-click website (2026-11-15): the private SiteVault edit link for a site
-- AdVault made for this campaign, encrypted with TOKEN_ENCRYPTION_KEY (the
-- same v1 envelope as the Google tokens). Null = no SiteVault site.
-- Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sitevault_edit_enc text;
