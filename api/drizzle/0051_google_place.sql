-- "Find my business on Google" (2026-11-27, lib/places). Only the Google
-- place_id is kept (Google's terms allow caching it); every other Places field
-- is re-fetched when needed and never stored.
--   google_place_id     the place the owner picked in the wizard / website form
--   show_google_rating  "Show my Google rating in the ad": the renderer fetches
--                       the rating fresh at render time and adds
--                       "★ 4.8 on Google (120 reviews)" when it is 4.0+ with 5+
--                       reviews.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS google_place_id text;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS show_google_rating boolean NOT NULL DEFAULT false;
