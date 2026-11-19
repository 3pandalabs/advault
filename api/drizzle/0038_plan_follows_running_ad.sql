-- The $19 plan follows the running ad (2026-11-19, lib/planBilling).
--   "$19 a month while your ad is running. Pause anytime: no fee while paused."
--   First month included with the first ad, exactly once per account.
--
-- users.plan_first_month_used_at   when this account's included first month
--                                  was used (its $0 first period was paid).
--                                  NULL = still available. Backfilled for
--                                  every account that has already paid a plan
--                                  invoice: the credit is for new customers.
-- subscriptions.first_month_included  this subscription's first period is the
--                                  included month (a $0 invoice; Stripe trial).
-- subscriptions.included_until     end of that included month (MRR skips it).
-- subscriptions.provider_subscription_ref / provider_customer_ref
--                                  Stripe sub_... / cus_..., captured from the
--                                  webhook, so the plan can be stopped at the
--                                  end of the period (cancel_at_period_end),
--                                  un-stopped, and restarted off-session.
-- subscription_invoices amount may now be 0 (the included month).
-- Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_first_month_used_at timestamptz;
--> statement-breakpoint
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS first_month_included boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS included_until timestamptz;
--> statement-breakpoint
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_ref text;
--> statement-breakpoint
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_customer_ref text;
--> statement-breakpoint
ALTER TABLE subscription_invoices DROP CONSTRAINT IF EXISTS sub_invoices_amount_check;
--> statement-breakpoint
ALTER TABLE subscription_invoices ADD CONSTRAINT sub_invoices_amount_check CHECK (amount_minor >= 0);
--> statement-breakpoint
UPDATE users SET plan_first_month_used_at = now()
 WHERE plan_first_month_used_at IS NULL
   AND id IN (SELECT user_id FROM subscription_invoices WHERE status = 'paid');
