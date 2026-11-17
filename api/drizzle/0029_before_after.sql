-- "Show your work: before & after" (2026-11-17, lib/beforeAfter). Up to two
-- pairs of real photos of one job on a campaign, [{beforeAssetId,
-- afterAssetId}], and who attested "These are real photos of our own work"
-- and when. NULL = none (every existing row). Asset ids are plain jsonb, not
-- foreign keys: a deleted photo just drops out of the pair at generation.
-- Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS before_after jsonb;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS before_after_attested_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS before_after_attested_by uuid;
