-- Real-estate ad type and listing facts, 2026-11-13 (lib/realty).
--   { adType: 'listing' | 'agent', price?, beds?, baths?,
--     openHouse?: { date, start, end } }
-- NULL for every other category. Idempotent: runs at every API start.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS realty jsonb;
