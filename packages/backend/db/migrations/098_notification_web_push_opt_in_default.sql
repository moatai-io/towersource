-- ============================================================
-- 098: Browser/PWA Web Push remains explicit opt-in
-- ============================================================

-- Existing true values can represent a user's explicit prior settings action.
-- Do not rewrite rows here. Only ensure newly created preference rows do not
-- make OS-level notifications look enabled before the user opts in.
ALTER TABLE user_notification_preferences
  ALTER COLUMN web_push_enabled SET DEFAULT false;
