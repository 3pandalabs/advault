-- Managed ("we handle the ad spend") billing: a customer's Google Ads account
-- is paid for by 3PandaLabs with a per-customer Mercury virtual debit card.
--
-- Google has no API that adds a payment method, so a platform-billed account
-- now has a real waiting state: AdVault creates the account and the card, an
-- operator adds the card in Google Ads, and AdVault polls until a funded
-- billing setup appears. billing_link_status carries that state for platform
-- accounts too (it was customer-only before).
--
-- Additive and idempotent, like every migration here: they run at container
-- start, and one that cannot be re-run crash-loops the API.

ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS mercury_card_id text;
ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS mercury_card_last_four text;
ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS mercury_card_status text;
ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS mercury_card_limit_cents integer;
ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS ops_notified_at timestamptz;
ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS ops_reminder_count integer NOT NULL DEFAULT 0;

-- Was: billing_link_status only for managed + customer-billed accounts.
-- Now: any managed account (platform accounts wait for the operator's card).
ALTER TABLE ad_accounts DROP CONSTRAINT IF EXISTS ad_accounts_billing_link_applicability_check;
DO $$ BEGIN
  ALTER TABLE ad_accounts ADD CONSTRAINT ad_accounts_billing_link_applicability_check
    CHECK (billing_link_status IS NULL OR is_managed = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
