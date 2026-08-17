-- Files uploaded directly into a people-centered channel.
-- Physical files live under workspace/uploads/channels/<channel-id>/; this table
-- is the active share registry and preserves original display metadata.
CREATE TABLE IF NOT EXISTS channel_shared_files (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  channel_id    TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  storage_path  TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_channel_shared_files_active
  ON channel_shared_files(channel_id, created_at DESC)
  WHERE removed_at IS NULL;

COMMENT ON TABLE channel_shared_files IS
  'Files explicitly shared with current and future channel participants and invited Agents.';
