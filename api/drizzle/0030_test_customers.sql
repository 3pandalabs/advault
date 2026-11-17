-- Admin test customers (2026-11-17). A real admin can create separate
-- customer accounts to test as, and switch into them, so the one-per-account
-- things (website, Google Ads child account, Mercury card, plan) can be
-- tested again from scratch (routes/testCustomers.ts, lib/testMode).
--   users.test_owner_id   the admin who owns this test customer; NULL for
--                         every real account. Non-NULL = always test mode
--                         ($0.50 charges, tagged test, launch is a dry run).
-- A test customer has a random password nobody knows and a *.invalid email,
-- so it cannot log in on its own and no mail can reach a real person.
-- Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS test_owner_id uuid;

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_test_owner_id_fkey FOREIGN KEY (test_owner_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS users_test_owner_id_idx ON users (test_owner_id) WHERE test_owner_id IS NOT NULL;
