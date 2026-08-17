-- 127: Pin each isolated AI Service Conversation to one real Tower runtime Session.
-- The runtime Session is private, server-created, and uses the Deployment Harness snapshot.

ALTER TABLE ai_service_conversations
  ADD COLUMN IF NOT EXISTS runtime_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_service_conversations_runtime_session
  ON ai_service_conversations(runtime_session_id)
  WHERE runtime_session_id IS NOT NULL;
