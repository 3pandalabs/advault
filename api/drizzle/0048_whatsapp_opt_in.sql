-- WhatsApp phone + opt-in (2026-11-21, lib/phone, lib/whatsapp).
--   users.whatsapp_opt_in_at  when the owner ticked "Message me on WhatsApp
--                             about my ads"; NULL = never message them
--                             (every outbound needs it, in every mode).
--   users.phone               now stored as E.164 ("+13323168453"); the
--                             WhatsApp sender is matched EXACTLY on it.
-- Existing numbers that already carry a "+" country code are rewritten to
-- E.164 (digits only after the plus, 8-15 digits). Anything else is left as
-- typed (lib/offers userForPhone still matches such a legacy row on the full
-- digit string). Idempotent: a second run changes nothing.

ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at timestamptz;
--> statement-breakpoint
UPDATE users
   SET phone = '+' || regexp_replace(phone, '[^0-9]', '', 'g')
 WHERE phone LIKE '+%'
   AND phone <> '+' || regexp_replace(phone, '[^0-9]', '', 'g')
   AND length(regexp_replace(phone, '[^0-9]', '', 'g')) BETWEEN 8 AND 15;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS users_phone_idx ON users (phone) WHERE phone IS NOT NULL;
