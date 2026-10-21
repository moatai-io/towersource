-- Additive OTP credential snapshot. Historical rows have NULL and fail verification;
-- do not rewrite or cancel pending rows during a live migration.
ALTER TABLE auth_login_otp_challenges ADD COLUMN IF NOT EXISTS auth_epoch INTEGER;
