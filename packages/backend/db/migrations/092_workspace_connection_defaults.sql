-- 085_workspace_connection_defaults.sql — Visible default-on connection policy
--
-- Default connections are first-class admin-visible policy rows. They answer:
-- "Which connections are on by default for projects unless explicitly denied?"
-- Secret values remain only in secret_store.

CREATE TABLE IF NOT EXISTS workspace_connection_defaults (
  connection_id   TEXT PRIMARY KEY,                  -- profile:<id> or credential:<id>
  default_mode    TEXT NOT NULL DEFAULT 'all_projects', -- all_projects | new_projects | project_template
  project_template TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  risk_ack_required BOOLEAN NOT NULL DEFAULT false,
  reason          TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INT REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      INT REFERENCES users(id),

  CONSTRAINT workspace_connection_defaults_id_chk CHECK (
    connection_id ~ '^(profile|credential):[a-z0-9][a-z0-9_-]{1,79}$'
  ),
  CONSTRAINT workspace_connection_defaults_mode_chk CHECK (
    default_mode IN ('all_projects', 'new_projects', 'project_template')
  )
);

CREATE INDEX IF NOT EXISTS workspace_connection_defaults_enabled_idx
  ON workspace_connection_defaults (enabled, default_mode);

COMMENT ON TABLE workspace_connection_defaults IS
  'Admin-visible default-on connection policy. Makes implicit workspace/internal-default inheritance explicit and manageable.';

-- Backfill the legacy implicit inheritance model into visible default rows.
-- Disabled credentials become disabled defaults so re-enabling the credential does
-- not silently re-expand access without an explicit admin action.
INSERT INTO workspace_connection_defaults
  (connection_id, default_mode, enabled, risk_ack_required, reason, metadata)
SELECT
  'credential:' || id,
  'all_projects',
  enabled,
  false,
  'Backfilled from legacy ' || scope || ' credential inheritance',
  jsonb_build_object('source', 'migration_092', 'legacy_scope', scope)
FROM workspace_credentials
WHERE scope IN ('workspace', 'internal-default')
ON CONFLICT (connection_id) DO NOTHING;
