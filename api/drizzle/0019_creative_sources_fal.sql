-- Cinematic ads made through fal (Gemini Omni Flash) and the fal ElevenLabs
-- voice, 2026-11-14: widen the source checks. Idempotent: drop + re-add.

ALTER TABLE creatives DROP CONSTRAINT IF EXISTS creatives_motion_source_check;
ALTER TABLE creatives ADD CONSTRAINT creatives_motion_source_check
  CHECK (motion_source in ('none','kling','luma','fal','veo'));
ALTER TABLE creatives DROP CONSTRAINT IF EXISTS creatives_voice_source_check;
ALTER TABLE creatives ADD CONSTRAINT creatives_voice_source_check
  CHECK (voice_source in ('none','edge-tts','elevenlabs','fal'));
