-- ============================================================
-- 004: Notifications
-- ============================================================

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  user_id    INTEGER NOT NULL,                -- SQLite users.id reference
  room_id    TEXT REFERENCES chat_rooms(id) ON DELETE CASCADE,
  notif_type TEXT NOT NULL DEFAULT 'mention',
  -- valid notif_type: mention, task_done, task_failed, room_invite, system (app-level validation)
  title      TEXT NOT NULL,
  body       TEXT,
  metadata   JSONB DEFAULT '{}',
  read       INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, read, created_at DESC);
