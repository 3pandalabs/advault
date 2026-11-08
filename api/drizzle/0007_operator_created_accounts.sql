-- Operator-created Google Ads accounts.
--
-- Google refuses CreateCustomerClient for a manager account until a linked
-- account has spent over $1,000 (CREATION_DENIED_INELIGIBLE_MCC, since March
-- 2025, UI and API alike). Until then a 3PandaLabs operator creates each
-- platform customer's account by hand, names it with a short reference code,
-- and links it under the MCC; the renderer's sweep finds it by that code.
--
-- So a managed row can now exist BEFORE its Google customer id is known:
-- provision_status = 'pending', customer_id NULL, provision_ref set.
--
-- Idempotent, like every migration here.

ALTER TABLE ad_accounts ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS provision_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_accounts_provision_ref
  ON ad_accounts (provision_ref) WHERE provision_ref IS NOT NULL;

-- Digits only, as before — or NULL while waiting for the operator's account.
ALTER TABLE ad_accounts DROP CONSTRAINT IF EXISTS ad_accounts_customer_id_check;
DO $$ BEGIN
  ALTER TABLE ad_accounts ADD CONSTRAINT ad_accounts_customer_id_check
    CHECK (customer_id ~ '^[0-9]{5,20}$' OR (customer_id IS NULL AND provision_status = 'pending'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
