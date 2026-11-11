-- $19 new-ad purchases for the Keep it running plan, 2026-11-11.
-- Idempotent: drop and re-add the CHECK with the wider list.
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_sku_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_sku_check
  CHECK (sku IN ('cinematic','new_ad'));
