-- ============================================================
-- 003: Room AI Context (per-room AI memory)
-- ============================================================

CREATE TABLE room_ai_context (
  id             TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  room_id        TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  context_type   TEXT NOT NULL DEFAULT 'task_result',
  -- valid context_type: task_result, pinned (app-level validation)
  content        TEXT NOT NULL,
  token_count    INTEGER NOT NULL DEFAULT 0,
  source_task_id TEXT,                         -- SQLite tasks.id reference
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ                   -- NULL = pinned (no expiry)
);

CREATE INDEX idx_room_ai_context_room ON room_ai_context(room_id, created_at DESC);
CREATE INDEX idx_room_ai_context_expiry ON room_ai_context(expires_at)
  WHERE expires_at IS NOT NULL;
