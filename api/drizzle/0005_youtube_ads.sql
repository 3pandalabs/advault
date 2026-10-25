-- The YouTube upload chain, and the ad-group/ad resource names that make a
-- launched campaign able to serve something.
--
-- Until this migration, a launch created a budget, a campaign and geo targets
-- and then stopped: no ad group, no ad. The campaign was a budgeted shell that
-- could never show anything, and nothing in the system said so.
--
-- Purely additive and idempotent. Migrations run at container start here, so a
-- migration that cannot be re-run crash-loops the API container and takes the
-- app down — this happened to RentVault on 2026-07-24. drizzle-kit emits bare
-- ADD COLUMN / ADD CONSTRAINT, which are NOT idempotent; every statement below
-- is IF NOT EXISTS or wrapped in a duplicate_object handler.

-- Where an advertiser's own channel grant lives. Absence of a row means their
-- ads go to the org channel, which is the default and the only shape that works
-- for a managed advertiser with no channel of their own.
CREATE TABLE IF NOT EXISTS youtube_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  channel_id text NOT NULL,
  title text,

  -- AES-256-GCM, same key as the Google Ads tokens. A grant that can publish
  -- to someone's channel gets the same treatment as one that can spend their
  -- money.
  refresh_token_ciphertext text NOT NULL,
  scope text,

  status text NOT NULL DEFAULT 'active',

  connected_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- One channel per advertiser: reconnecting replaces rather than accumulating
-- grants that uploads could land on either of.
CREATE UNIQUE INDEX IF NOT EXISTS uq_youtube_channels_user
  ON youtube_channels (user_id);

DO $$ BEGIN
  ALTER TABLE youtube_channels
    ADD CONSTRAINT youtube_channels_status_check
    CHECK (status IN ('active','revoked'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The upload queue. Separate from render_jobs because an upload has to be
-- retryable long after its render finished — an advertiser who connects their
-- own channel in month three wants the back catalogue moved without re-encoding
-- anything.
CREATE TABLE IF NOT EXISTS youtube_upload_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,

  claimed_by text,
  claimed_at timestamptz,
  run_after timestamptz NOT NULL DEFAULT now(),

  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_youtube_upload_jobs_claim
  ON youtube_upload_jobs (status, run_after);

-- Idempotence for the enqueue, and the thing that stops one creative being
-- published to the channel twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_youtube_upload_jobs_creative_open
  ON youtube_upload_jobs (creative_id)
  WHERE status IN ('queued','running');

DO $$ BEGIN
  ALTER TABLE youtube_upload_jobs
    ADD CONSTRAINT youtube_upload_jobs_status_check
    CHECK (status IN ('queued','running','done','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Upload state per creative. Deliberately not folded into render_status: a
-- creative that encoded fine and failed to upload is a different problem to
-- show the advertiser than one that never encoded, and collapsing the two is
-- how "launched but can never serve" stayed invisible.
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS youtube_upload_status text NOT NULL DEFAULT 'pending';
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS youtube_upload_error text;
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS youtube_channel_source text;
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS google_ad_resource_name text;

DO $$ BEGIN
  ALTER TABLE creatives
    ADD CONSTRAINT creatives_youtube_upload_status_check
    CHECK (youtube_upload_status IN ('pending','uploading','done','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE creatives
    ADD CONSTRAINT creatives_youtube_channel_source_check
    CHECK (youtube_channel_source IS NULL OR youtube_channel_source IN ('org','advertiser'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Already-uploaded creatives (there are none in production today, but a
-- re-run on a future database must stay honest): a video id present means the
-- upload is done, and it predates the per-creative source column.
UPDATE creatives
   SET youtube_upload_status = 'done'
 WHERE youtube_video_id IS NOT NULL
   AND youtube_upload_status <> 'done';

-- One ad group per campaign. A target-frequency video campaign supports exactly
-- one, so this does not need its own table.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS google_ad_group_resource_name text;
