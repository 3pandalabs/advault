-- Customer-uploaded videos + human review, 2026-11-12.
--
-- Any user can now attach a finished MP4 to their campaign (routes/uploads.ts),
-- but it must be approved by an AdVault admin before it is published to YouTube
-- or launched. review_status is NULL for everything AdVault generated — those
-- never need review — and pending_review -> approved | rejected for uploads.
--
-- Also stores Google's own policy verdict on the launched ad, read by the
-- renderer's hourly report sweep (render/adMetricsSync.ts).
--
-- Idempotent: runs at every API container start.

ALTER TABLE creatives ADD COLUMN IF NOT EXISTS review_status text;
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS review_reason text;
-- "I own or have the rights to everything in this video, including the music."
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS rights_attested_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS rights_attested_at timestamptz;

-- Uploads that existed before review did were admin-only, i.e. ours: approved.
UPDATE creatives SET review_status = 'approved'
 WHERE kind = 'upload' AND review_status IS NULL;

ALTER TABLE creatives DROP CONSTRAINT IF EXISTS creatives_review_status_check;
ALTER TABLE creatives ADD CONSTRAINT creatives_review_status_check
  CHECK (review_status IS NULL OR review_status IN ('pending_review','approved','rejected'));

-- The admin review queue's only query.
CREATE INDEX IF NOT EXISTS idx_creatives_pending_review
  ON creatives (created_at) WHERE review_status = 'pending_review';

-- Google's policy review of the campaign's (single) ad.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS google_ad_approval_status text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS google_ad_review_status text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS google_ad_policy_topics text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS google_ad_policy_checked_at timestamptz;
