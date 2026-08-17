-- 169: Public AI Service Conversation resume grants
-- Stores only token hashes; raw resume credentials are returned once to the browser.

CREATE TABLE IF NOT EXISTS ai_service_conversation_resume_grants (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id TEXT NOT NULL REFERENCES ai_service_conversations(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES ai_service_channels(id) ON DELETE CASCADE,
  tenant_key TEXT NOT NULL,
  user_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_conversation_resume_scope
  ON ai_service_conversation_resume_grants(conversation_id, channel_id, tenant_key, user_key)
  WHERE revoked_at IS NULL;
