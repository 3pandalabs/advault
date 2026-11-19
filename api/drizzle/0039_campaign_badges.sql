-- Badges and credentials (2026-11-20, lib/categories/badges.ts): the trust
-- badges an owner ticked for a campaign ("Licensed & insured", "ASE
-- certified"...) as {"ids": [...], "licenseNumber": "..."}, and who attested
-- "These are true for my business today" and when. NULL = none (every
-- existing row). Used by the next ad made (end-card chips). Idempotent.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS badges jsonb;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS badges_attested_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS badges_attested_by uuid;
