-- 217: Account email invitations, verified identities, and browser-login OTP challenges.
-- This migration is additive. Existing users keep working while TOWER_LOGIN_EMAIL_OTP=off.

CREATE TABLE IF NOT EXISTS account_email_identities (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'verified', 'superseded', 'cancelled')),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('invite', 'existing_user', 'change')),
  verified_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((state = 'verified' AND verified_at IS NOT NULL) OR state <> 'verified')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_identities_one_verified_per_user
  ON account_email_identities(user_id)
  WHERE state = 'verified';

CREATE INDEX IF NOT EXISTS idx_account_email_identities_user_state
  ON account_email_identities(user_id, state);

CREATE TABLE IF NOT EXISTS account_email_invitations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('viewer', 'guest', 'member', 'operator', 'admin')),
  display_name TEXT,
  affiliation TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  provider_message_id TEXT,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_email_invitations_status_expires
  ON account_email_invitations(status, expires_at);

CREATE TABLE IF NOT EXISTS account_email_verification_challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_identity_id BIGINT NOT NULL REFERENCES account_email_identities(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired', 'superseded', 'cancelled', 'delivery_failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  provider_message_id TEXT,
  request_ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_verification_one_pending
  ON account_email_verification_challenges(email_identity_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS auth_login_otp_challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_identity_id BIGINT NOT NULL REFERENCES account_email_identities(id) ON DELETE RESTRICT,
  otp_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired', 'superseded', 'cancelled', 'attempts_exceeded', 'delivery_failed')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0 AND failed_attempts <= 5),
  expires_at TIMESTAMPTZ NOT NULL,
  resend_available_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  provider_message_id TEXT,
  request_ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_login_otp_one_pending_per_user
  ON auth_login_otp_challenges(user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_auth_login_otp_user_created
  ON auth_login_otp_challenges(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS account_security_events (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'blocked')),
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_security_events_target_created
  ON account_security_events(target_user_id, created_at DESC);

COMMENT ON TABLE account_email_identities IS 'Globally unique account email reservations and verified primary identities.';
COMMENT ON TABLE account_email_invitations IS 'Administrator-designated one-time email invitations. Store token hashes only.';
COMMENT ON TABLE account_email_verification_challenges IS 'Existing-user and email-change verification links. Store token hashes only.';
COMMENT ON TABLE auth_login_otp_challenges IS 'Browser login OTP challenges. Never store or log plaintext OTP values.';
COMMENT ON TABLE account_security_events IS 'Secret-free audit events for account email and OTP security flows.';
