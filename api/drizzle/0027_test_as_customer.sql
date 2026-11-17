-- Admin "Test as customer" mode (2026-11-17). When on, an admin's billing and
-- perk exemptions are switched off (they pay like a standard advertiser) and
-- every Stripe charge is the $0.50 test price (lib/testMode, lib/pricing
-- TEST_PRICE_MINOR). Admin pages keep working, so the admin can switch back.
--   users.test_as_customer   the switch; only an admin may turn it on
-- Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS test_as_customer boolean NOT NULL DEFAULT false;
