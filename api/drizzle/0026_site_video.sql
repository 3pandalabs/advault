-- Ad video on the website comes with launch (2026-11-16). "Make me a website"
-- no longer sends the ad video; launching with "Also show this ad on my
-- website" (default on) asks SiteVault to add it. Once added it stays, even if
-- the plan stops or the ad is paused.
--   campaigns.site_video_wanted      launch asked for it
--   campaigns.site_video_pushed_at   SiteVault accepted it; NULL = not yet
--   campaigns.site_video_attempts    tries (the API sweep retries a few times)
--   campaigns.site_video_error       last failure, for ops
-- Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS site_video_wanted boolean NOT NULL DEFAULT false;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS site_video_pushed_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS site_video_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS site_video_error text;
