-- 135: Revocation ledger for AI Service Channel credentials.
-- Public serving verifies the signed token and then checks this table by token hash.

CREATE TABLE IF NOT EXISTS ai_service_channel_credential_revocations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token_hash TEXT NOT NULL UNIQUE,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES ai_service_channels(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'revoked',
  revoked_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_service_channel_credential_revocations_channel
  ON ai_service_channel_credential_revocations(channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_service_channel_credential_revocations_token
  ON ai_service_channel_credential_revocations(token_hash);
