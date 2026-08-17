-- ============================================================
-- 095: Configurable invite-code signup approval policy
-- ============================================================
-- 결정: workspace/decisions/2026-06-21-invite-code-approval-policy-setting.md

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (key, value)
VALUES ('signup.approval_mode', '"auto"'::jsonb)
ON CONFLICT (key) DO NOTHING;
