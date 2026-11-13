-- Audience filters + real-estate radius targeting, 2026-11-12.
-- audience_filters: optional "Who should see it" filters (age, gender, parental
--   status, household income, language). NULL = everyone (the default).
-- target_address: the listing address a real-estate campaign targets a radius
--   around. US housing ads may not target ZIP codes (Google policy), so those
--   campaigns store no ZIPs and this instead.
-- Idempotent: runs at every API container start.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_filters jsonb;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_address jsonb;
--> statement-breakpoint
-- Was array_length(...) between 1 and 50, which let an EMPTY array through
-- (array_length('{}') is NULL and a CHECK passes NULL). Now: at most 50 ZIPs,
-- and at least one ZIP unless the campaign targets a radius around an address.
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_zips_check;
--> statement-breakpoint
ALTER TABLE campaigns ADD CONSTRAINT campaigns_zips_check CHECK (
  coalesce(array_length(target_zip_codes, 1), 0) <= 50
  AND (coalesce(array_length(target_zip_codes, 1), 0) >= 1 OR target_address IS NOT NULL)
) NOT VALID;
-- NOT VALID: enforced for every new write, but an old row that somehow holds
-- an empty array can't fail this migration and crash-loop the container.
