-- Additive revocation generation. Legacy JWTs without authEpoch map to zero only;
-- once an account is reactivated, pre-disable JWTs (including 2-second iat grace)
-- and CLI/service JWTs can never regain access.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_epoch INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN users.auth_epoch IS 'Increments on reactivation; JWT authEpoch must equal the current account epoch.';
