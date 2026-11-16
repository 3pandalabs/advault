-- One 3PandaLabs account across AdVault and SiteVault (2026-11-16).
-- AdVault's users table is the shared account store: SiteVault creates its
-- sign-ups here (POST /internal/sitevault/accounts) and checks logins here
-- (verify-login), so the same email + password works on both apps.
--   users.signup_app               where the account was created: 'advault' | 'sitevault'
--   users.advault_first_used_at    first AdVault campaign (NULL = never used AdVault)
--   users.sitevault_first_used_at  first SiteVault website (NULL = never used SiteVault)
-- A NULL first-use means "signed up there or elsewhere, but never used it".
-- Backfill (approximate times; only presence matters for the usage split):
--   AdVault: the earliest campaign.
--   SiteVault: a campaign AdVault made a SiteVault site for (edit link or
--   pending site), dated by the website purchase if any, else the campaign.
--   SiteVault itself reports usage for the rest on the owner's next sign-in.
-- Idempotent: every statement is safe to re-run, and the backfill only fills
-- NULLs or moves a first-use earlier.

ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_app text NOT NULL DEFAULT 'advault';
ALTER TABLE users ADD COLUMN IF NOT EXISTS advault_first_used_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sitevault_first_used_at timestamptz;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_signup_app_check;
ALTER TABLE users ADD CONSTRAINT users_signup_app_check CHECK (signup_app IN ('advault','sitevault'));

UPDATE users u
   SET advault_first_used_at = c.first_at
  FROM (SELECT user_id, min(created_at) AS first_at FROM campaigns GROUP BY user_id) c
 WHERE c.user_id = u.id
   AND (u.advault_first_used_at IS NULL OR u.advault_first_used_at > c.first_at);

UPDATE users u
   SET sitevault_first_used_at = s.first_at
  FROM (
    SELECT c.user_id,
           min(coalesce(
             (SELECT min(p.created_at) FROM purchases p
               WHERE p.campaign_id = c.id AND p.website_slug IS NOT NULL),
             c.created_at)) AS first_at
      FROM campaigns c
     WHERE c.sitevault_edit_enc IS NOT NULL OR c.sitevault_pending_url IS NOT NULL
     GROUP BY c.user_id
  ) s
 WHERE s.user_id = u.id
   AND (u.sitevault_first_used_at IS NULL OR u.sitevault_first_used_at > s.first_at);

-- Which apps each live account uses. The ONE definition of the usage split:
-- metrics, the SiteVault-only selector (lib/sharedAccount) and ad-hoc ops
-- queries all read it, e.g.
--   SELECT email FROM account_app_usage WHERE app_usage = 'sitevault_only';
CREATE OR REPLACE VIEW account_app_usage AS
SELECT u.id,
       u.email,
       u.signup_app,
       u.created_at,
       u.advault_first_used_at,
       u.sitevault_first_used_at,
       CASE
         WHEN u.advault_first_used_at IS NOT NULL AND u.sitevault_first_used_at IS NOT NULL THEN 'both'
         WHEN u.advault_first_used_at IS NOT NULL THEN 'advault_only'
         WHEN u.sitevault_first_used_at IS NOT NULL THEN 'sitevault_only'
         ELSE 'neither'
       END AS app_usage
  FROM users u
 WHERE u.deleted_at IS NULL;
