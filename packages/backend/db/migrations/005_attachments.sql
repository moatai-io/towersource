-- ============================================================
-- 005: File Attachments
-- ============================================================

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  message_id  TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  file_size   BIGINT NOT NULL,
  mime_type   TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attachments_message ON attachments(message_id);
