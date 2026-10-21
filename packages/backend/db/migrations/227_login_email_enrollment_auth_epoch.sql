-- Capture the account authentication epoch at password-login enrollment time.
-- A disable/reactivate cycle changes this epoch even if the password timestamp is unchanged.
ALTER TABLE auth_login_email_enrollments
  ADD COLUMN IF NOT EXISTS auth_epoch INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN auth_login_email_enrollments.auth_epoch IS 'Authentication epoch captured at password login; verification must match current users.auth_epoch.';
