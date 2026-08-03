-- HAND-WRITTEN, and idempotent for the same reason 0001 is: migrations run on
-- every API container start (see ../Dockerfile), so a statement that fails on
-- re-run crash-loops production. That is what took RentVault down on
-- 2026-07-24. Every ADD COLUMN carries IF NOT EXISTS, every ADD CONSTRAINT is
-- wrapped in a DO $$ ... WHEN duplicate_object guard, and the one data
-- backfill is scoped to `WHERE billing_mode IS NULL` so replaying it cannot
-- overwrite a value an operator has since changed.
--
-- Splits "did we provision this account" (is_managed, already present) from
-- "whose card does Google charge" (billing_mode, new). The two were previously
-- conflated: is_managed = true implied platform-funded, which made the
-- customer-funded MCC child — a child account under our MCC that the
-- advertiser pays for themselves — inexpressible.

ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "billing_mode" text;
--> statement-breakpoint

-- Backfill before NOT NULL. Pre-existing managed children were funded by the
-- MCC payments account, so they are 'platform'; every brought-your-own
-- connection was and remains 'customer'. Scoped to NULLs, so re-running is a
-- no-op rather than a silent revert.
UPDATE "ad_accounts"
   SET "billing_mode" = CASE WHEN "is_managed" THEN 'platform' ELSE 'customer' END
 WHERE "billing_mode" IS NULL;
--> statement-breakpoint

-- New rows default to the safe mode: customer-funded carries no float and no
-- chargeback exposure, so an accidentally-defaulted row cannot cost us money.
ALTER TABLE "ad_accounts" ALTER COLUMN "billing_mode" SET DEFAULT 'customer';
--> statement-breakpoint
ALTER TABLE "ad_accounts" ALTER COLUMN "billing_mode" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "billing_link_status" text;
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "billing_invitation_resource_name" text;
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "billing_invited_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "billing_confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "billing_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "billing_payments_account_id" text;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_billing_mode_check" CHECK ("ad_accounts"."billing_mode" in ('platform','customer'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Our payments account can only sit behind an account we provisioned. Without
-- this, flipping a brought-your-own connection to 'platform' would quietly
-- point the wallet at someone else's spend.
DO $$ BEGIN
 ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_platform_billing_managed_check" CHECK ("ad_accounts"."billing_mode" = 'customer' or "ad_accounts"."is_managed" = true);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_billing_link_status_check" CHECK ("ad_accounts"."billing_link_status" is null
          or "ad_accounts"."billing_link_status" in ('pending','invited','active','failed'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The invitation handshake exists only for managed accounts the customer pays
-- for. Platform-billed and BYO accounts leave it null, so the launch guard can
-- read null as "not applicable" rather than "not done yet".
DO $$ BEGIN
 ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_billing_link_applicability_check" CHECK ("ad_accounts"."billing_link_status" is null
          or ("ad_accounts"."is_managed" = true and "ad_accounts"."billing_mode" = 'customer'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The billing-status poller scans for accounts mid-handshake. Partial, because
-- the overwhelming majority of rows are null here and will stay that way.
CREATE INDEX IF NOT EXISTS "idx_ad_accounts_billing_link_pending" ON "ad_accounts" ("billing_link_status","billing_checked_at") WHERE "billing_link_status" in ('pending','invited');
