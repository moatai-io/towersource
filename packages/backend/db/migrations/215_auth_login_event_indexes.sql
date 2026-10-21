-- 215: Add login visibility indexes after the account and event schema exists.

CREATE INDEX IF NOT EXISTS idx_auth_login_events_user_time
  ON auth_login_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_login_events_time
  ON auth_login_events(created_at DESC);
