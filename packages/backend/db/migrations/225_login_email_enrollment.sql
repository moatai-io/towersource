-- Browser-only, pre-session enrollment. Never store plaintext OTP or issue a session at creation.
CREATE TABLE IF NOT EXISTS auth_login_email_enrollments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  password_changed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','expired','superseded','cancelled','attempts_exceeded','delivery_failed')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  expires_at TIMESTAMPTZ NOT NULL,
  resend_available_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  provider_message_id TEXT,
  request_ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_login_email_enrollments_pending_user ON auth_login_email_enrollments(user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_login_email_enrollments_user_created ON auth_login_email_enrollments(user_id,created_at DESC);
COMMENT ON TABLE auth_login_email_enrollments IS 'Pre-session existing-account email enrollment, OTP hash only; intentionally no verified identity before successful code consumption.';
