-- 180: Conversation-scoped external user files for public AI Service chats.

CREATE TABLE IF NOT EXISTS ai_service_conversation_files (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES ai_service_deployments(id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL REFERENCES ai_service_channels(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ai_service_conversations(id) ON DELETE CASCADE,
  tenant_key TEXT NOT NULL,
  user_key TEXT NOT NULL,
  project_relative_path TEXT NOT NULL,
  representation_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'ready' CHECK (processing_status IN ('processing','ready','processing_failed','deleted')),
  processing_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_service_conversation_files_conversation
  ON ai_service_conversation_files(conversation_id, created_at)
  WHERE deleted_at IS NULL;
