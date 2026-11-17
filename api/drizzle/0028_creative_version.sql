-- Ad version numbers (2026-11-17). A redo replaces the campaign's ad, so the
-- page showed no sign that the video was a new one. creatives.version counts
-- the makes of the campaign's ad (1 = first, +1 per redo) and the campaign
-- page shows "Version N". Existing rows read as version 1. Idempotent.

ALTER TABLE creatives ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
