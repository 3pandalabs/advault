-- Client attestation & compliance (2026-11-20, lib/compliance, CLAUDE.md
-- "Client attestation & compliance").
--
-- ad_attestations    one row per time a client ticked "my claims are true" +
--                    "I have rights to my media" (order, generate, redo,
--                    upload, launch) or the website-ownership tick (website):
--                    the exact text, its version, IP, user agent and a
--                    snapshot of what the ad said at that moment.
-- terms_acceptances  one row per Terms of Service version a user accepted.
-- ad_reports         public "Report this ad" submissions (/report?ad=<public id>).
-- campaigns.public_id           unguessable id for the public report link.
-- campaigns.compliance_*        ok | needs_review | taken_down, the flagged
--                               phrases and the admin who reviewed/took down.
-- creatives.generation_inputs   the exact input the script writer got.
--
-- APPEND-ONLY: ad_attestations and terms_acceptances refuse UPDATE, DELETE and
-- TRUNCATE in a trigger (advault_append_only). The ONE allowed UPDATE is one
-- that changes nothing except blanking ip_address and/or user_agent, which is
-- what account deletion does (lib/accountDeletion.ts). No foreign keys on
-- purpose: the rows must outlive the campaign/creative/purchase they describe
-- (an owner can delete a campaign), and an ON DELETE action would be an
-- UPDATE/DELETE the trigger refuses. users rows are never deleted (anonymised).
-- The trigger guards against application code, not against the database
-- owner, who could drop it.
--
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS first):
-- migrations run at every advault-api start.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS public_id text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaigns_public_id ON campaigns (public_id);
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS compliance_status text NOT NULL DEFAULT 'ok';
--> statement-breakpoint
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_compliance_status_check;
--> statement-breakpoint
ALTER TABLE campaigns ADD CONSTRAINT campaigns_compliance_status_check CHECK (compliance_status IN ('ok', 'needs_review', 'taken_down'));
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS compliance_reasons jsonb;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS compliance_reviewed_by uuid;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS compliance_reviewed_at timestamptz;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS taken_down_at timestamptz;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS taken_down_by uuid;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS taken_down_reason text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_campaigns_compliance_status ON campaigns (compliance_status) WHERE compliance_status <> 'ok';
--> statement-breakpoint
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS generation_inputs jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ad_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid,
  creative_id uuid,
  purchase_id uuid,
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('order', 'generate', 'redo', 'upload', 'launch', 'website')),
  attestation_text_version text NOT NULL,
  exact_text_snapshot text NOT NULL,
  ip_address text,
  user_agent text,
  content_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ad_attestations_campaign ON ad_attestations (campaign_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ad_attestations_user ON ad_attestations (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ad_attestations_purchase ON ad_attestations (purchase_id) WHERE purchase_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  version text NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_terms_acceptances_user ON terms_acceptances (user_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ad_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('false_or_misleading', 'scam_or_fraud', 'offensive', 'copyright_or_privacy', 'prohibited_product', 'other')),
  details text,
  reporter_email text,
  ip_address text,
  user_agent text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid,
  handled_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ad_reports_status ON ad_reports (status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ad_reports_ip ON ad_reports (ip_address, created_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION advault_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Account deletion may blank the network identifiers; nothing else changes.
    IF (to_jsonb(NEW) - 'ip_address' - 'user_agent') = (to_jsonb(OLD) - 'ip_address' - 'user_agent')
       AND (NEW.ip_address IS NULL OR NEW.ip_address IS NOT DISTINCT FROM OLD.ip_address)
       AND (NEW.user_agent IS NULL OR NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ad_attestations_append_only ON ad_attestations;
--> statement-breakpoint
CREATE TRIGGER ad_attestations_append_only BEFORE UPDATE OR DELETE ON ad_attestations FOR EACH ROW EXECUTE FUNCTION advault_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS ad_attestations_no_truncate ON ad_attestations;
--> statement-breakpoint
CREATE TRIGGER ad_attestations_no_truncate BEFORE TRUNCATE ON ad_attestations FOR EACH STATEMENT EXECUTE FUNCTION advault_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS terms_acceptances_append_only ON terms_acceptances;
--> statement-breakpoint
CREATE TRIGGER terms_acceptances_append_only BEFORE UPDATE OR DELETE ON terms_acceptances FOR EACH ROW EXECUTE FUNCTION advault_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS terms_acceptances_no_truncate ON terms_acceptances;
--> statement-breakpoint
CREATE TRIGGER terms_acceptances_no_truncate BEFORE TRUNCATE ON terms_acceptances FOR EACH STATEMENT EXECUTE FUNCTION advault_append_only();
