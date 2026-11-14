-- Pay per ad for everyone, 2026-11-13.
--
-- Every non-admin pays $10 before AdVault makes an ad (not only Keep it
-- running subscribers), and a paid ad includes RENDERS_PER_AD renders: the
-- first plus two redos (lib/newAd). renders_used counts them on the new_ad
-- order. Orders already delivered have used one.
--
-- Idempotent: runs at every API container start.

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS renders_used integer NOT NULL DEFAULT 0;
UPDATE purchases SET renders_used = 1 WHERE sku = 'new_ad' AND status = 'delivered' AND renders_used = 0;
