-- Website optional, 2026-11-15: a business with no website can still make
-- ads. Launch to Google Ads still needs a URL (Demand Gen requires a final
-- URL), which the launch route checks (landing_url_required).
-- Idempotent: DROP NOT NULL on an already-nullable column is a no-op.

ALTER TABLE campaigns ALTER COLUMN landing_url DROP NOT NULL;
