-- ============================================================
-- 012: Add source_message_id to sessions (thread → session link)
-- ============================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source_message_id TEXT;
