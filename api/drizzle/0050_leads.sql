-- Leads inbox (2026-11-27, lib/leads, routes/leads.ts + routes/sitevaultLeads.ts).
-- "Request a quote", "Call me back" and booking requests sent from a
-- customer's SiteVault site (SiteVault POSTs /internal/sitevault/leads). The
-- site owner sees them on /dashboard/leads and by email.
--   user_id      the owning account; NULL when SiteVault named no owner we
--                could match (stored anyway, ops alerted). Deleted with the
--                account (lib/accountDeletion).
--   owner_email  the owner email SiteVault sent, lowercased (lets a NULL-user
--                lead still be listed for that owner by email).
--   campaign_id  the AdVault campaign the visitor came from (utm_campaign).
--   status       a booking starts 'requested', every other kind 'new'.
--   booking_*    booking requests only; overlap is refused under an advisory
--                lock per site (lib/leads createLead).
-- Idempotent: IF NOT EXISTS everywhere.

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  owner_email text,
  site_slug text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  name text NOT NULL,
  phone text NOT NULL,
  email text,
  message text,
  best_time text,
  photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  booking_service text,
  booking_duration_min integer,
  booking_start timestamptz,
  booking_end timestamptz,
  booking_timezone text,
  source jsonb,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  owner_emailed_at timestamptz,
  customer_emailed_status text,
  review_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leads_kind_check CHECK (kind IN ('quote','callback','booking')),
  CONSTRAINT leads_status_check CHECK (status IN ('new','requested','contacted','confirmed','declined','done')),
  CONSTRAINT leads_booking_check CHECK (kind <> 'booking' OR (booking_start IS NOT NULL AND booking_end IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS leads_slug_idempotency_key ON leads (site_slug, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_user ON leads (user_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_site_slug ON leads (site_slug, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_booking_start ON leads (site_slug, booking_start) WHERE booking_start IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads (campaign_id) WHERE campaign_id IS NOT NULL;
