-- Results screen breakdowns (2026-11-19). One row per (campaign, Google report
-- date, dimension, segment): who saw the ad (age, gender, device), where
-- (postal / city from user_location_view, network) and when (hour). Day of
-- week is derived from campaign_daily_metrics dates, not stored. Filled by the
-- renderer's read-only report sweep (render/adMetricsSync.ts), which replaces
-- the re-read window on every pass. `label` holds a resolved place name for
-- location rows (segment = geoTargetConstants/<id>), NULL otherwise.
-- Idempotent.
CREATE TABLE IF NOT EXISTS campaign_segment_metrics (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  date date NOT NULL,
  dimension text NOT NULL,
  segment text NOT NULL,
  label text,
  impressions bigint NOT NULL DEFAULT 0,
  views bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_segment_metrics
  ON campaign_segment_metrics (campaign_id, date, dimension, segment);

DO $$ BEGIN
  ALTER TABLE campaign_segment_metrics ADD CONSTRAINT campaign_segment_metrics_dimension_check
    CHECK (dimension IN ('age', 'gender', 'device', 'network', 'hour', 'postal', 'city'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
