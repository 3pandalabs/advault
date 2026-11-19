-- Low ad-budget alert (2026-11-19, top-up-first model). The renderer's spend
-- sync marks a live, platform-funded campaign when its wallet falls under
-- max(2 days of budget, $10) and pings the operator once; a healthy balance
-- (a top-up) clears it so the next dip alerts again. One alert per episode.
-- The customer-facing banner is computed live from the balance, not this.
-- Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS low_balance_alerted_at timestamptz;
