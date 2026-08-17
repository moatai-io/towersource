-- OAuth tokens for external services (Kakao, Slack, Telegram, etc.)
CREATE TABLE IF NOT EXISTS user_oauth_tokens (
  id TEXT PRIMARY KEY DEFAULT (uuid_generate_v4()::TEXT),
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,              -- 'kakao' | 'slack' | 'telegram'
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at BIGINT,             -- Unix timestamp (ms)
  refresh_expires_at BIGINT,           -- Unix timestamp (ms)
  provider_user_id TEXT,               -- provider-side user identifier
  provider_nickname TEXT,              -- display name from provider
  metadata JSONB DEFAULT '{}',         -- extra provider-specific data
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON user_oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON user_oauth_tokens(provider);
