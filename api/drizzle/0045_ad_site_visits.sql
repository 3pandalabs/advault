-- Ad click tracking (2026-11-21, lib/siteVisits, routes/siteVisits.ts).
-- A test ad was shown 180 times with 1 click and 0 sign-ups, and nothing told
-- us what the person who clicked did. New launches now carry
-- utm_campaign=<campaign id> on the final URL (lib/googleAds/utm); when such a
-- visit lands on advault.3pandalabs.com the web app reports it ONCE per
-- browser session to the public POST /track/visit.
--
-- campaign_site_visits is a counter, one row per (campaign, day, path):
-- NO IP address, NO user agent, no visitor id, nothing about the person.
-- Deleted with the campaign.
--
-- users.signup_campaign_id: the campaign whose ad brought this account (the
-- web app keeps the id for 30 days and sends it with POST /auth/register).
-- Nullable; SET NULL if the campaign goes. Not personal data about the user
-- beyond "came from that ad", so account deletion leaves it.
--
-- Idempotent (IF NOT EXISTS): migrations run at every advault-api start.

CREATE TABLE IF NOT EXISTS campaign_site_visits (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  day date NOT NULL,
  path text NOT NULL,
  visits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day, path)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_campaign_site_visits_day ON campaign_site_visits (day);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_signup_campaign ON users (signup_campaign_id) WHERE signup_campaign_id IS NOT NULL;
