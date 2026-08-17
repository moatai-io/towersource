-- ============================================================
-- 091: Signup invite codes + admin approval
-- ============================================================
-- 결정: workspace/decisions/2026-06-18-invite-code-signup-admin-approval.md

CREATE TABLE IF NOT EXISTS signup_invite_codes (
  id            SERIAL PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,
  label         TEXT DEFAULT '',
  default_role  TEXT NOT NULL DEFAULT 'member',
  max_uses      INTEGER,
  used_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_invite_code_id INTEGER REFERENCES signup_invite_codes(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

UPDATE users
   SET approval_status = 'active',
       approved_at = COALESCE(approved_at, created_at)
 WHERE approval_status IS NULL OR approval_status = '';

CREATE INDEX IF NOT EXISTS idx_users_approval_status ON users(approval_status);
CREATE INDEX IF NOT EXISTS idx_users_signup_invite_code_id ON users(signup_invite_code_id);
CREATE INDEX IF NOT EXISTS idx_signup_invite_codes_disabled ON signup_invite_codes(disabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_invite_codes_code_lower ON signup_invite_codes(lower(code));
