-- 134: Usage ledger for token-authenticated AI Service Channel serving.
-- This is the audit/ops substrate for per-channel, per-tenant quota and budget controls.

CREATE TABLE IF NOT EXISTS ai_service_channel_usage_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES ai_service_channels(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES ai_service_conversations(id) ON DELETE SET NULL,
  tenant_key TEXT NOT NULL,
  user_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('credential_issued','conversation_created','message_turn')),
  exposure TEXT NOT NULL DEFAULT 'auth-required' CHECK (exposure IN ('auth-required','unlisted','public')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_service_channel_usage_channel_time
  ON ai_service_channel_usage_events(channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_service_channel_usage_tenant_time
  ON ai_service_channel_usage_events(service_id, tenant_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_service_channel_usage_event_time
  ON ai_service_channel_usage_events(event_type, created_at DESC);
