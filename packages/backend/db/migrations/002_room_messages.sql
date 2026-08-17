-- ============================================================
-- 002: Room Messages
-- ============================================================

CREATE TABLE room_messages (
  id          TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  room_id     TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  sender_id   INTEGER,                       -- SQLite users.id reference, NULL = system
  seq         BIGSERIAL,                     -- monotonic ordering (handles same-timestamp inserts)
  msg_type    TEXT NOT NULL DEFAULT 'human',
  -- valid msg_type: human, ai_summary, ai_task_ref, ai_error, system (app-level validation)
  content     TEXT NOT NULL,
  metadata    JSONB DEFAULT '{}',
  task_id     TEXT,                           -- SQLite tasks.id reference (cross-DB)
  reply_to    TEXT REFERENCES room_messages(id),
  edited_at   TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ,                    -- soft delete
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_room_messages_room ON room_messages(room_id, created_at);
CREATE INDEX idx_room_messages_seq ON room_messages(room_id, seq);
CREATE INDEX idx_room_messages_sender ON room_messages(sender_id);
CREATE INDEX idx_room_messages_task ON room_messages(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_room_messages_active ON room_messages(room_id, created_at)
  WHERE deleted_at IS NULL;
