-- $10 website fee (2026-11-15): "Make me a website" charges $10 (first year
-- of SiteVault Pro included) for advertisers who pay per ad. AdVault creates
-- the site unpublished (SiteVault awaitingPayment), charges, and after the
-- webhook tells SiteVault it's paid (POST /api/internal/sites/<slug>/paid);
-- only then does the site become the campaign's landing_url.
--   campaigns.sitevault_pending_url  the made-but-unpaid site; NULL otherwise
--   purchases.website_slug           the SiteVault site a 'website' purchase pays for
--   purchases.website_published_at   when SiteVault accepted the payment; NULL = not yet
--   purchases.website_error          last failure, for ops
--   purchases.website_attempts       tries (the API sweep retries a few times)
-- Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sitevault_pending_url text;

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS website_slug text;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS website_published_at timestamptz;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS website_error text;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS website_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_sku_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_sku_check
  CHECK (sku IN ('cinematic','new_ad','cinematic_pack','site_offer','website'));

-- The retry sweep's queue: paid website fees SiteVault hasn't applied yet.
CREATE INDEX IF NOT EXISTS idx_purchases_website_unpublished ON purchases (created_at)
  WHERE website_slug IS NOT NULL AND website_published_at IS NULL;
