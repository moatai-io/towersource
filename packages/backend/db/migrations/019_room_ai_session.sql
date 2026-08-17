-- Persistent Channel AI: add session tracking to rooms
ALTER TABLE chat_rooms
  ADD COLUMN IF NOT EXISTS ai_engine_session_id TEXT,
  ADD COLUMN IF NOT EXISTS ai_session_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_session_message_count INTEGER DEFAULT 0;
