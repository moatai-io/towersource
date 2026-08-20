-- 187: Persist each user's preferred AI response language.
-- NULL means inherit the Admin Panel default, then WORKSPACE_LANGUAGE fallback.

ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_language_supported;
ALTER TABLE users ADD CONSTRAINT users_language_supported
  CHECK (language IS NULL OR language IN ('en', 'ko'));

COMMENT ON COLUMN users.language IS
  'Preferred AI response language. NULL inherits app_settings language.default_response, then WORKSPACE_LANGUAGE.';
