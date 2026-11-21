-- "Change my offer" on a launched campaign (2026-11-21, lib/offerSwap).
--
-- A change is a cheap RE-CUT of the campaign's launched ad (same photo motion
-- clips, opener and voice; only the offer text, sticker, captions and the
-- voiceover are new), published as NEW creatives and added to the SAME ad
-- group as a NEW ad. The old ad is paused/removed only after Google approves
-- the new one. On the end date the campaign returns to its BASE ad (no
-- offer); it keeps running.
--
--   offer_changes              one row per requested change (kind 'offer'),
--                              plus at most one no-offer base cut per campaign
--                              (kind 'base') when the launched ad had an offer.
--   creatives.offer_change_id  the change a re-cut creative belongs to.
--   campaigns.base_ad_resource_name  the ad the campaign returns to when an
--                              offer ends (the launched ad when it had no
--                              offer, else the base cut's ad). Paused while an
--                              offer runs; never removed.
--   campaigns.live_offer_change_id   which offer is serving now (NULL = base /
--                              the launched ad).
--   whatsapp_messages.media_*  inbound photo / voice note (R2 key, deleted
--                              after use; transcript kept with the message).
--   purchases sku 'offer_change'  the $2 change (lib/pricing).
-- Idempotent.

CREATE TABLE IF NOT EXISTS offer_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'offer',
  offer_text text,
  call_to_action text,
  ends_at timestamptz,
  ends_at_inferred boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'web',
  status text NOT NULL DEFAULT 'rendering',
  charge text,
  billing_month date,
  price_minor integer NOT NULL DEFAULT 0,
  purchase_id uuid REFERENCES purchases(id) ON DELETE SET NULL,
  new_photo_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  google_ad_resource_name text,
  replaced_ad_resource_name text,
  offer_cycle_id uuid REFERENCES offer_cycles(id) ON DELETE SET NULL,
  review_phrases jsonb,
  error text,
  ops_alerted_at timestamptz,
  confirmed_at timestamptz,
  google_added_at timestamptz,
  live_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE offer_changes ADD CONSTRAINT offer_changes_kind_check CHECK (kind IN ('offer','base'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE offer_changes ADD CONSTRAINT offer_changes_source_check CHECK (source IN ('web','whatsapp'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE offer_changes ADD CONSTRAINT offer_changes_status_check CHECK (status IN (
    'rendering','preview','awaiting_payment','publishing','pending_google','parked',
    'live','ended','disapproved','failed','cancelled','superseded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE offer_changes ADD CONSTRAINT offer_changes_charge_check CHECK (charge IS NULL OR charge IN ('included','paid','exempt'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- An offer always has text and an end date ("an offer outliving its
  -- deadline" is the one thing this feature must never do).
  ALTER TABLE offer_changes ADD CONSTRAINT offer_changes_offer_shape_check
    CHECK (kind = 'base' OR (offer_text IS NOT NULL AND ends_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_offer_changes_campaign ON offer_changes (campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_offer_changes_user_month ON offer_changes (user_id, billing_month) WHERE charge = 'included';
-- The swap sweep's queue.
CREATE INDEX IF NOT EXISTS idx_offer_changes_open ON offer_changes (status)
  WHERE status IN ('rendering','publishing','pending_google','parked','live');
-- One offer change in flight per campaign (a newer preview supersedes an
-- older preview; nothing else may start while one is publishing).
CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_changes_in_flight ON offer_changes (campaign_id)
  WHERE kind = 'offer' AND status IN ('rendering','preview','awaiting_payment','publishing','pending_google');
-- The plan's ONE included change per calendar month (OFFER_CHANGES_INCLUDED_
-- PER_MONTH = 1) is enforced here, not by a count: two tabs (or WhatsApp and
-- the web) confirming at once cannot both get it free. A change Google
-- refused or that broke gives it back (its status leaves the predicate).
CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_changes_included_month ON offer_changes (user_id, billing_month)
  WHERE charge = 'included' AND status NOT IN ('disapproved','failed','cancelled');
-- At most one usable base cut per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_changes_base ON offer_changes (campaign_id)
  WHERE kind = 'base' AND status NOT IN ('failed','cancelled','superseded');

ALTER TABLE creatives ADD COLUMN IF NOT EXISTS offer_change_id uuid;
DO $$ BEGIN
  ALTER TABLE creatives ADD CONSTRAINT creatives_offer_change_fk
    FOREIGN KEY (offer_change_id) REFERENCES offer_changes(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_creatives_offer_change ON creatives (offer_change_id) WHERE offer_change_id IS NOT NULL;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS base_ad_resource_name text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS live_offer_change_id uuid;

ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_type text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_key text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS transcript text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS offer_change_id uuid;

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_sku_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_sku_check
  CHECK (sku IN ('cinematic','new_ad','cinematic_pack','site_offer','website','offer_change'));
