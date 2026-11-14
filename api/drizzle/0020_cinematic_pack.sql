-- Cinematic 3-pack, 2026-11-14: a 'cinematic_pack' purchase grants three
-- credits; a cinematic order paid with one has provider 'pack'.
-- Idempotent: drop + re-add.

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_sku_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_sku_check
  CHECK (sku IN ('cinematic','new_ad','cinematic_pack'));
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_provider_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_provider_check
  CHECK (provider IN ('razorpay','stripe','paddle','manual','pack'));
