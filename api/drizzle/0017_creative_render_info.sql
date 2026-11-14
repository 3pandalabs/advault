-- What a render actually used, 2026-11-13: engine (template | ffmpeg), motion
-- clips made / reused and by which provider, voice source. Lets ops answer
-- "did this ad animate, did it use fal" without container logs
-- (GET /admin/recent-renders). Idempotent: runs at every API start.

ALTER TABLE creatives ADD COLUMN IF NOT EXISTS render_info jsonb;
