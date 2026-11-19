-- "$55 a month", option C (2026-11-19, lib/schedule/spread.ts): spread the
-- month's ad budget across the month with the ad schedule.
--
-- campaigns.schedule_mode   'spread' = AdVault picks the days from the ad
--                           budget (at launch and whenever budget is added);
--                           'custom' = the owner's own schedule (or every
--                           day), never changed by AdVault.
-- Every existing campaign is 'custom' (nothing about them changes); new
-- campaigns default to 'spread'. Idempotent: the column is added with the
-- backfill default, then the default switches for new rows.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS schedule_mode text NOT NULL DEFAULT 'custom';
--> statement-breakpoint
ALTER TABLE campaigns ALTER COLUMN schedule_mode SET DEFAULT 'spread';
--> statement-breakpoint
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_schedule_mode_check;
--> statement-breakpoint
ALTER TABLE campaigns ADD CONSTRAINT campaigns_schedule_mode_check CHECK (schedule_mode IN ('spread', 'custom'));
