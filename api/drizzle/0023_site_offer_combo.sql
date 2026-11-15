-- Offer combo (2026-11-15): a $10 new ad can also put the same offer on the
-- business's SiteVault site (+$2, or 1 SiteVault credit, or free when
-- SiteVault billing is off / for admins and at_cost accounts).
--   site_offer_mode      'paid' | 'credit' | 'free'; NULL = no website offer
--   site_offer_text      the offer as sent (offerBanner of the campaign offer)
--   site_offer_slug      the SiteVault site (<slug>.3pandasite.com)
--   site_offer_pushed_at when SiteVault accepted it; NULL = not yet
--   site_offer_error     last failure, for the campaign page and ops
--   site_offer_attempts  pushes tried (the API sweep retries a few times)
-- Admin/at_cost free pushes are their own $0 rows with sku 'site_offer'.
-- Idempotent.

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS site_offer_mode text;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS site_offer_text text;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS site_offer_slug text;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS site_offer_pushed_at timestamptz;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS site_offer_error text;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS site_offer_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_site_offer_mode_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_site_offer_mode_check
  CHECK (site_offer_mode IS NULL OR site_offer_mode IN ('paid','credit','free'));

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_sku_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_sku_check
  CHECK (sku IN ('cinematic','new_ad','cinematic_pack','site_offer'));

-- The retry sweep's queue: paid site offers SiteVault hasn't accepted yet.
CREATE INDEX IF NOT EXISTS idx_purchases_site_offer_unpushed ON purchases (created_at)
  WHERE site_offer_mode IS NOT NULL AND site_offer_pushed_at IS NULL;
