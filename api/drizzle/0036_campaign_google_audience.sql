-- Editing "Who should see it" on a launched campaign (2026-11-20). Launch
-- creates ONE Audience at Google for the demographic filters
-- (lib/googleAds/demandGen.ts); its resource name was never stored. Kept now
-- (at launch and after every edit) so the campaign row says which Audience is
-- serving. The edit itself still reads the ad group's criteria from Google
-- first (lib/googleAds/targeting.ts), so rows launched before this column
-- exist (NULL) are edited correctly too. Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS google_audience_resource_name text;
