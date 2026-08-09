-- One-off add-on purchases, and the creative kind that distinguishes what they
-- produce from what the subscription produces.
--
-- Purely additive and idempotent. Migrations run at container start here, so a
-- migration that cannot be re-run crash-loops the API container and takes the
-- app down — this happened to RentVault on 2026-07-24. Every statement below is
-- IF NOT EXISTS or wrapped in a duplicate_object handler.

CREATE TABLE IF NOT EXISTS purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,

  add_on_key text NOT NULL,
  sku text NOT NULL,
  currency_code text NOT NULL,
  amount_minor integer NOT NULL,

  provider text NOT NULL,
  provider_ref text,

  status text NOT NULL DEFAULT 'pending',

  brief jsonb,

  attempts integer NOT NULL DEFAULT 0,
  last_error text,

  paid_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases (user_id, created_at);

-- The replay guard. Both PSPs retry webhook delivery by design, and without
-- this a retried delivery charges a one-off sale a second time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchases_provider_ref
  ON purchases (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

-- The renderer's queue. Partial because delivered rows accumulate forever and
-- are never producible again.
CREATE INDEX IF NOT EXISTS idx_purchases_producible
  ON purchases (created_at)
  WHERE status = 'paid';

DO $$ BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_currency_check
    CHECK (currency_code IN ('INR','USD'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_sku_check
    CHECK (sku IN ('cinematic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_provider_check
    CHECK (provider IN ('razorpay','stripe','paddle','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_status_check
    CHECK (status IN ('pending','paid','producing','delivered','failed','refunded','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Zero is legal: the at_cost margin waiver still produces a real artefact and
-- therefore still needs a row. Revenue queries must filter amount_minor > 0
-- rather than assume every row here is a sale.
DO $$ BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_amount_check
    CHECK (amount_minor >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 'standard' is every creative that existed before this migration: the
-- subscription pipeline animating the advertiser's own photos. 'cinematic' is
-- the paid add-on, which is a different render path with a different per-unit
-- cost and a different failure policy, so the renderer must be able to tell
-- them apart before it claims the job.
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'standard';
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS purchase_id uuid;

DO $$ BEGIN
  ALTER TABLE creatives ADD CONSTRAINT creatives_kind_check
    CHECK (kind IN ('standard','cinematic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Spelled here rather than in schema.ts because `purchases` is declared after
-- `creatives` in that file and a forward reference would be evaluated before
-- the table exists. The constraint is real either way.
DO $$ BEGIN
  ALTER TABLE creatives ADD CONSTRAINT creatives_purchase_id_fkey
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_creatives_purchase
  ON creatives (purchase_id)
  WHERE purchase_id IS NOT NULL;
