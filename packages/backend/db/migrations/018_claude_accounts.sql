-- ============================================================
-- 018: Claude Accounts — multi-account credential rotation
-- ============================================================
-- Allows assigning different Claude Max/Pro subscriptions to projects.
-- Each account points to a separate CLAUDE_CONFIG_DIR with its own OAuth tokens.

CREATE TABLE IF NOT EXISTS claude_accounts (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    config_dir  TEXT NOT NULL UNIQUE,
    tier        TEXT NOT NULL DEFAULT 'max',
    is_default  BOOLEAN DEFAULT false,
    enabled     BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Link projects to specific Claude accounts (nullable = use default)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'claude_account_id'
  ) THEN
    ALTER TABLE projects ADD COLUMN claude_account_id TEXT
      REFERENCES claude_accounts(id) ON DELETE SET NULL;
  END IF;
END $$;
