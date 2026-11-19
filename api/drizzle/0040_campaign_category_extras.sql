-- Category extras (2026-11-20, lib/categories/extras.ts): a restaurant's
-- featured dish and order/reserve link, an auto shop's makes, a landscaper's
-- existing-customer ZIPs, as one jsonb object. NULL = none (every existing
-- row). Used by the next ad made. Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS category_extras jsonb;
