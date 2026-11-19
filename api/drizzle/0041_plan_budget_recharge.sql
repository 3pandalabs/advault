-- "From $55 a month" (owner decision 2026-11-19): the AdVault plan goes from
-- $19 to $20, and each month the subscription also charges the customer's
-- chosen ad budget (min $35), credited to their ad budget wallet (lib/planBilling,
-- lib/subscriptions). Same for everyone: the $19 plan had no real customers,
-- so nothing is grandfathered. Both new columns default to 0.
--
-- subscriptions.budget_recharge_minor   ad budget charged with every PAID
--                                       month of this subscription: the
--                                       customer's chosen amount (3500 = $35;
--                                       0 = none, e.g. customer-billed).
--                                       PUT /subscription/ad-budget changes it
--                                       from the next invoice on.
-- subscription_invoices.budget_minor    the ad budget part of THIS invoice
--                                       (0 for the included first month).
--                                       The provider charges amount_minor +
--                                       budget_minor; on payment amount_minor
--                                       is the fee and budget_minor becomes a
--                                       wallet top-up (external ref
--                                       sub:<invoice>:budget, once per invoice).
--
-- users.plan_choice                     "Keep it running" ('monthly', the
--                                       default) or "Just this once"
--                                       ('once'): no plan, no recharge, the ad
--                                       runs on its budget until it runs out.
--                                       Plan gates let a 'once' account run;
--                                       the plan sync never restarts or
--                                       un-stops a plan for it.
-- Idempotent.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS budget_recharge_minor integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS budget_minor integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_budget_recharge_check;
--> statement-breakpoint
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_budget_recharge_check CHECK (budget_recharge_minor >= 0);
--> statement-breakpoint
ALTER TABLE subscription_invoices DROP CONSTRAINT IF EXISTS sub_invoices_budget_check;
--> statement-breakpoint
ALTER TABLE subscription_invoices ADD CONSTRAINT sub_invoices_budget_check CHECK (budget_minor >= 0);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_choice text NOT NULL DEFAULT 'monthly';
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_choice_check;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_plan_choice_check CHECK (plan_choice IN ('monthly', 'once'));
