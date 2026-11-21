-- Accounts marked as test (2026-11-21, POST /admin/test-accounts). Some
-- ordinary sign-ups are really ours, such as the Google Play reviewer's demo
-- login or our own QA account, and were counted as real customers. They must
-- keep working exactly like a customer (log in, real launches, real prices),
-- so they cannot become admin test customers (users.test_owner_id, 0030:
-- no login, dry-run launches, $0.50 prices).
--   users.marked_test   true = left out of real customers, revenue and
--                       traction numbers (/admin/business, /metrics,
--                       /admin/ad-production, /admin/account-counts "test").
--                       Changes NO login, price, gate or launch.
-- Set by a real admin on /dashboard/admin/users. Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS marked_test boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS users_marked_test_idx ON users (id) WHERE marked_test;
