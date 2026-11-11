-- "Keep it running" (evergreen) plan, 2026-11-11: a third subscription line.
-- Idempotent: drop and re-add the CHECK with the wider list.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_line_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_line_check
  CHECK (line IN ('offer','managed','evergreen'));
