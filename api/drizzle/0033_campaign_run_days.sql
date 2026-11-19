-- How long an ad runs (2026-11-18). The new-campaign wizard asks
-- "How long should your ad run?": 1 week, 2 weeks or always on.
--   campaigns.run_days  7 or 14; NULL = always on (no end date, the default).
--   campaigns.ends_on   the last serving day, set at launch from run_days and
--                       sent to Google as Campaign.end_date_time, so Google
--                       stops the campaign by itself. NULL = no end date.
-- Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS run_days integer;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ends_on date;

DO $$ BEGIN
  ALTER TABLE campaigns ADD CONSTRAINT campaigns_run_days_check CHECK (run_days IS NULL OR run_days IN (7, 14));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
