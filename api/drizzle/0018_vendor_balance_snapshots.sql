-- Prepaid vendor balances over time, 2026-11-14: the renderer reads fal's
-- credit balance hourly (render/falBalanceWatch.ts) so the low-balance alert
-- can size its threshold from the real spend rate. Idempotent: runs at every
-- API start.

CREATE TABLE IF NOT EXISTS vendor_balance_snapshots (
  id bigserial PRIMARY KEY,
  vendor text NOT NULL,
  balance_micros bigint NOT NULL,
  currency_code text NOT NULL DEFAULT 'USD',
  -- ok | low | critical, as judged when this reading was taken.
  alert_level text NOT NULL DEFAULT 'ok',
  -- Whether this reading sent a phone alert (re-alerts are spaced from it).
  alerted boolean NOT NULL DEFAULT false,
  taken_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_balance_snapshots_vendor_taken
  ON vendor_balance_snapshots (vendor, taken_at);
