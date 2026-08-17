-- 159 (4/4): Per-session ordering indexes. Plain (non-concurrent) B-tree builds
-- on an already-populated bigint column — fast relative to the GIN indexes the
-- backfill step (159_messages_message_seq_2_backfill.sql) had to touch.

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_message_seq
  ON messages(session_id, message_seq);

CREATE INDEX IF NOT EXISTS idx_messages_session_order
  ON messages(session_id, message_seq);
