-- HAND-WRITTEN and idempotent, for the reason 0001 and 0002 are: migrations run
-- on every API container start (see ../Dockerfile), so a statement that fails on
-- re-run crash-loops production. That is what took RentVault down on
-- 2026-07-24. drizzle-kit emits bare CREATE TABLE / ADD COLUMN / ADD CONSTRAINT
-- and none of those are idempotent, so this file is written by hand: every
-- object carries IF NOT EXISTS and every ADD CONSTRAINT is wrapped in a
-- DO $$ ... WHEN duplicate_object guard.
--
-- What this adds:
--   * subscriptions + subscription_invoices — the recurring platform fee, which
--     is the ONLY thing in this codebase that has ever earned money. Before
--     this, every plan carried monthlyFeeMinor = 0 and no ledger row was ever
--     written with type 'fee'.
--   * offer_cycles + whatsapp_messages — the monthly "what's this month's
--     offer?" conversation that the subscription is actually selling.
--   * campaigns.offer_expires_at — an offer ad that outlives its deadline is
--     worse than no ad, and nothing at Google pauses it for us.
--
-- Purely additive: no column is dropped, no existing row is rewritten. The old
-- one-off `creation_fee` payment purpose is left in place so historical rows
-- stay readable, even though nothing issues it any more.

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "plan_key" text NOT NULL,
  "line" text NOT NULL,
  "currency_code" text NOT NULL,
  "amount_minor" integer NOT NULL,
  "provider" text NOT NULL,
  "provider_ref" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "canceled_at" timestamp with time zone,
  "failed_charge_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_line_check" CHECK ("subscriptions"."line" in ('offer','managed'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_currency_check" CHECK ("subscriptions"."currency_code" in ('INR','USD'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_provider_check" CHECK ("subscriptions"."provider" in ('razorpay','stripe','paddle','manual'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('pending','active','past_due','canceled','expired'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- A zero-amount subscription is precisely the bug this table exists to fix.
-- at_cost customers get no row at all rather than a free one, so "how many
-- people pay us" is answerable by counting rows.
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_amount_check" CHECK ("subscriptions"."amount_minor" > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_subscriptions_user" ON "subscriptions" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscriptions_due" ON "subscriptions" ("current_period_end") WHERE "status" in ('active','past_due');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_subscriptions_provider_ref" ON "subscriptions" ("provider","provider_ref") WHERE "provider_ref" is not null;
--> statement-breakpoint

-- At most one live subscription per user. Without this a double-submitted
-- checkout bills someone every month forever and nothing in the system notices.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_subscriptions_one_live" ON "subscriptions" ("user_id") WHERE "status" in ('pending','active','past_due');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "subscription_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subscription_id" uuid NOT NULL REFERENCES "subscriptions"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "amount_minor" integer NOT NULL,
  "currency_code" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "paid_at" timestamp with time zone,
  "failure_reason" text,
  "external_ref" text,
  "provider_payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subscription_invoices" ADD CONSTRAINT "sub_invoices_currency_check" CHECK ("subscription_invoices"."currency_code" in ('INR','USD'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subscription_invoices" ADD CONSTRAINT "sub_invoices_status_check" CHECK ("subscription_invoices"."status" in ('pending','paid','failed','voided'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subscription_invoices" ADD CONSTRAINT "sub_invoices_amount_check" CHECK ("subscription_invoices"."amount_minor" > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subscription_invoices" ADD CONSTRAINT "sub_invoices_period_check" CHECK ("subscription_invoices"."period_end" > "subscription_invoices"."period_start");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sub_invoices_sub" ON "subscription_invoices" ("subscription_id","period_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sub_invoices_user" ON "subscription_invoices" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sub_invoices_ref" ON "subscription_invoices" ("subscription_id","external_ref") WHERE "external_ref" is not null;
--> statement-breakpoint

-- One invoice per period. This is what makes the renewal sweep safe to re-run:
-- a second pass for the same period is a caught duplicate, not a second charge.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sub_invoices_period" ON "subscription_invoices" ("subscription_id","period_start");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "offer_cycles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "subscription_id" uuid REFERENCES "subscriptions"("id") ON DELETE SET NULL,
  "campaign_id" uuid REFERENCES "campaigns"("id") ON DELETE SET NULL,
  "period_month" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "offer_text" text,
  "offer_expires_at" timestamp with time zone,
  "prompted_at" timestamp with time zone,
  "answered_at" timestamp with time zone,
  "previewed_at" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "reminder_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "offer_cycles" ADD CONSTRAINT "offer_cycles_status_check" CHECK ("offer_cycles"."status" in ('pending','prompted','answered','previewed','approved','skipped'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Exactly one cycle per user per month. This is what makes the scheduler safe
-- to run hourly: a second attempt in the same month is a caught duplicate
-- rather than a second WhatsApp message to a real person.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_offer_cycles_user_month" ON "offer_cycles" ("user_id","period_month");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_offer_cycles_open" ON "offer_cycles" ("status","prompted_at") WHERE "status" in ('pending','prompted','answered','previewed');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "whatsapp_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "offer_cycle_id" uuid REFERENCES "offer_cycles"("id") ON DELETE SET NULL,
  "direction" text NOT NULL,
  "phone" text NOT NULL,
  "body" text,
  "provider_ref" text,
  "status" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_direction_check" CHECK ("whatsapp_messages"."direction" in ('inbound','outbound'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_whatsapp_user" ON "whatsapp_messages" ("user_id","created_at");
--> statement-breakpoint

-- Meta redelivers any message the webhook did not 200. A redelivered "yes" must
-- not approve a second month's creative, so the provider id is the replay guard.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_whatsapp_provider_ref" ON "whatsapp_messages" ("provider_ref") WHERE "provider_ref" is not null;
--> statement-breakpoint

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "offer_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "offer_expired_at" timestamp with time zone;
--> statement-breakpoint

-- The expiry sweep scans for live campaigns whose offer deadline has passed.
-- Partial: the overwhelming majority of rows have no deadline set.
CREATE INDEX IF NOT EXISTS "idx_campaigns_offer_expiry" ON "campaigns" ("offer_expires_at") WHERE "offer_expires_at" is not null and "offer_expired_at" is null;
