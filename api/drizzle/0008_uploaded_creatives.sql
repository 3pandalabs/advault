-- Admin-uploaded finished videos: creatives.kind gains 'upload'. These skip the
-- renderer and go straight to the YouTube upload queue. Idempotent: drop and
-- re-add the CHECK with the wider list.
ALTER TABLE creatives DROP CONSTRAINT IF EXISTS creatives_kind_check;
ALTER TABLE creatives ADD CONSTRAINT creatives_kind_check
  CHECK (kind IN ('standard','cinematic','upload'));
