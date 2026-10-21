-- 212: Visible account login activity baseline
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;

CREATE TABLE IF NOT EXISTS auth_login_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('login_success', 'login_failure', 'logout')),
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE auth_login_events IS 'Authentication visibility events. Never store passwords, tokens, cookies, or reset links.';
