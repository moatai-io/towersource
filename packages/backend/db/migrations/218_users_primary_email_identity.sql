-- 218: Link users to their verified primary account email identity.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS primary_email_identity_id BIGINT
  REFERENCES account_email_identities(id) ON DELETE SET NULL;
