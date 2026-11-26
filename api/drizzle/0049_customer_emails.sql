-- Customer emails (2026-11-26, lib/customerEmails). Once-only guards for two
-- of the four emails (the welcome email needs none; the low-budget email reuses
-- campaigns.low_balance_alerted_at, 0034):
--   ad_accounts.ready_emailed_at  "Your ad account is ready" was sent (claimed
--                                 atomically on billing pending -> active).
--   creatives.ready_emailed_at    "Your ad is ready" was sent for this make;
--                                 set only on the make's first creative.
-- Existing creatives already on YouTube are marked as emailed so a deploy never
-- mails customers about ads they have had for weeks. Idempotent: the backfill
-- only runs in the same statement block that adds the column.

ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS ready_emailed_at timestamptz;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'creatives' AND column_name = 'ready_emailed_at'
  ) THEN
    ALTER TABLE creatives ADD COLUMN ready_emailed_at timestamptz;
    UPDATE creatives SET ready_emailed_at = now() WHERE youtube_video_id IS NOT NULL;
  END IF;
END $$;
