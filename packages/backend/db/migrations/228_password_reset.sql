-- Self-service password recovery: only hashed one-use capabilities are persisted.
CREATE TABLE IF NOT EXISTS account_password_reset_requests (
  id BIGSERIAL PRIMARY KEY,
  request_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_password_reset_requests_ip_created ON account_password_reset_requests(request_ip,created_at DESC);
CREATE TABLE IF NOT EXISTS account_password_reset_challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_identity_id BIGINT NOT NULL REFERENCES account_email_identities(id) ON DELETE RESTRICT,
  auth_epoch INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','expired','cancelled','delivery_failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  request_ip TEXT,
  provider_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_password_reset_user_created ON account_password_reset_challenges(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_password_reset_ip_created ON account_password_reset_challenges(request_ip, created_at DESC);
-- Multiple independently valid pending links permit a safe resend. Consuming one cancels the rest.
COMMENT ON TABLE account_password_reset_challenges IS 'Hashed one-use password reset links for verified primary account email.';
