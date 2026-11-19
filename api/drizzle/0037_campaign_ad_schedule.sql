-- Ad schedule (2026-11-20): the days and hours an ad may show.
--   campaigns.ad_schedule  {"days": ["mon", ...], "startHour": 0-23, "endHour": 1-24}
--                          NULL = every day, all day (the default).
-- Validated by the API (lib/schedule/policy.ts); sent to Google at launch as
-- one CampaignCriterion AdSchedule per day, and changeable on a launched
-- campaign through PUT /campaigns/:id/targeting. Hours are in the ad
-- account's time zone. Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ad_schedule jsonb;
