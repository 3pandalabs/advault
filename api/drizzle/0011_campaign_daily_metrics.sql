-- Ad performance analytics, 2026-11-12.
-- One row per (campaign, Google report date), filled by the renderer's
-- read-only metrics sweep (render/adMetricsSync.ts). The last few days are
-- re-read and overwritten on every pass because Google restates recent figures.
-- Idempotent: runs at every API container start.
CREATE TABLE IF NOT EXISTS campaign_daily_metrics (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  views bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_daily_metrics
  ON campaign_daily_metrics (campaign_id, date);
CREATE INDEX IF NOT EXISTS idx_campaign_daily_metrics_date
  ON campaign_daily_metrics (date);
