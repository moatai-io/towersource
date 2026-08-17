-- ============================================================
-- 083: Notification preferences + richer notification routing
-- ============================================================

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS action_url TEXT,
  ADD COLUMN IF NOT EXISTS channels JSONB NOT NULL DEFAULT '["in_app"]'::jsonb,
  ADD COLUMN IF NOT EXISTS delivered_channels JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notifications_user_project
  ON notifications(user_id, project_id, created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_type
  ON notifications(user_id, notif_type, created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  in_app_enabled BOOLEAN NOT NULL DEFAULT true,
  toast_enabled BOOLEAN NOT NULL DEFAULT true,
  web_push_enabled BOOLEAN NOT NULL DEFAULT false,

  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false,
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  timezone TEXT DEFAULT 'Asia/Seoul',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_notification_event_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,

  in_app BOOLEAN NOT NULL DEFAULT true,
  toast BOOLEAN NOT NULL DEFAULT true,
  web_push BOOLEAN NOT NULL DEFAULT false,
  min_priority TEXT NOT NULL DEFAULT 'normal',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (user_id, event_type)
);

CREATE TABLE IF NOT EXISTS user_notification_project_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  enabled BOOLEAN NOT NULL DEFAULT true,

  in_app BOOLEAN,
  toast BOOLEAN,
  web_push BOOLEAN,

  muted_until TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (user_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_project_prefs_user
  ON user_notification_project_preferences(user_id, enabled);
