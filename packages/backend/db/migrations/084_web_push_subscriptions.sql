-- ============================================================
-- 084: Browser/PWA Web Push subscriptions
-- ============================================================

CREATE TABLE IF NOT EXISTS user_push_subscriptions (
  id            TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,

  user_agent    TEXT,
  device_label  TEXT,
  platform      TEXT,
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  disabled_at   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_active
  ON user_push_subscriptions(user_id, last_seen_at DESC)
  WHERE disabled_at IS NULL;
