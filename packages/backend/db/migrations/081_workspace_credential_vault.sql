-- 081_workspace_credential_vault.sql — Workspace Credential Vault MVP
--
-- 결정:
--   workspace/decisions/2026-06-03-project-scoped-external-identities-for-runbox.md
--   workspace/decisions/2026-06-03-runtime-box-trusted-credential-pool.md
--
-- Issue #67: n8n-style workspace credential vault + target sync.
-- Secret values remain in secret_store.value_encrypted. These tables store
-- metadata, policies, target bindings, status, and audit events only.

-- ── 1) Workspace credential metadata ────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_credentials (
  id               TEXT PRIMARY KEY,                    -- e.g. 'gemini-default'
  kind             TEXT NOT NULL,                       -- 'api_key' first; github/azure/gws later
  provider         TEXT NOT NULL,                       -- 'gemini', 'openai', 'github', ...
  display_name     TEXT NOT NULL,
  secret_name      TEXT NOT NULL,                       -- points to secret_store.name; value never here
  default_env_name TEXT,                                -- e.g. 'GEMINI_API_KEY'
  scope            TEXT NOT NULL DEFAULT 'workspace',   -- 'workspace' | 'internal-default' | 'project'
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       INT REFERENCES users(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       INT REFERENCES users(id),
  rotated_at       TIMESTAMPTZ,

  CONSTRAINT workspace_credentials_kind_chk CHECK (
    kind IN ('api_key', 'github', 'azure', 'gws', 'oauth', 'service_account')
  ),
  CONSTRAINT workspace_credentials_scope_chk CHECK (
    scope IN ('workspace', 'internal-default', 'project')
  ),
  CONSTRAINT workspace_credentials_secret_name_chk CHECK (
    secret_name ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT workspace_credentials_default_env_chk CHECK (
    default_env_name IS NULL OR default_env_name ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

CREATE INDEX IF NOT EXISTS workspace_credentials_provider_idx
  ON workspace_credentials (provider, kind)
  WHERE enabled = true;

COMMENT ON TABLE workspace_credentials IS
  'Workspace Credential Vault metadata. Secret values live in secret_store and are never stored here.';
COMMENT ON COLUMN workspace_credentials.secret_name IS
  'Name of encrypted secret_store row. This is an identifier only, not a secret value.';

-- ── 2) Project inheritance / allow / deny policy ────────────────────────
CREATE TABLE IF NOT EXISTS project_credential_policies (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  credential_id   TEXT NOT NULL REFERENCES workspace_credentials(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL DEFAULT 'inherit',      -- inherit | allow | deny | override
  target_env_name TEXT,                                -- project override for API key env name
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INT REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      INT REFERENCES users(id),
  PRIMARY KEY (project_id, credential_id),
  CONSTRAINT project_credential_policies_mode_chk CHECK (
    mode IN ('inherit', 'allow', 'deny', 'override')
  ),
  CONSTRAINT project_credential_policies_env_chk CHECK (
    target_env_name IS NULL OR target_env_name ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

CREATE INDEX IF NOT EXISTS project_credential_policies_credential_idx
  ON project_credential_policies (credential_id, mode);

COMMENT ON TABLE project_credential_policies IS
  'Per-project policy for workspace credentials: inherit, allow, deny, or override.';

-- ── 3) Target sync bindings ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credential_target_syncs (
  id              BIGSERIAL PRIMARY KEY,
  credential_id   TEXT NOT NULL REFERENCES workspace_credentials(id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  target_type     TEXT NOT NULL,                       -- github_actions_secret first
  target_ref      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"repo":"juliuschun/verita2","secret_name":"GEMINI_API_KEY"}
  desired_state   TEXT NOT NULL DEFAULT 'present',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_status     TEXT,
  last_checked_at TIMESTAMPTZ,
  last_synced_at  TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INT REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      INT REFERENCES users(id),

  CONSTRAINT credential_target_syncs_type_chk CHECK (
    target_type IN ('github_actions_secret', 'azure_containerapp_env', 'runtime_box_env', 'gws_config')
  ),
  CONSTRAINT credential_target_syncs_desired_chk CHECK (
    desired_state IN ('present', 'absent')
  )
);

CREATE INDEX IF NOT EXISTS credential_target_syncs_project_idx
  ON credential_target_syncs (project_id, target_type)
  WHERE enabled = true;
CREATE INDEX IF NOT EXISTS credential_target_syncs_credential_idx
  ON credential_target_syncs (credential_id)
  WHERE enabled = true;

COMMENT ON TABLE credential_target_syncs IS
  'Target-specific materialization/sync bindings for credentials. target_ref contains non-secret target identifiers only.';

-- ── 4) Credential audit events ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credential_audit_events (
  id              BIGSERIAL PRIMARY KEY,
  credential_id   TEXT REFERENCES workspace_credentials(id) ON DELETE SET NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  target_sync_id  BIGINT REFERENCES credential_target_syncs(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,                       -- create | rotate | grant | status | sync | materialize | deny
  actor_user_id   INT REFERENCES users(id),
  provider        TEXT,
  target_type     TEXT,
  target_ref      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'ok',           -- ok | error | denied
  error_code      TEXT,
  message         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT credential_audit_events_status_chk CHECK (
    status IN ('ok', 'error', 'denied')
  )
);

CREATE INDEX IF NOT EXISTS credential_audit_events_created_idx
  ON credential_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS credential_audit_events_credential_idx
  ON credential_audit_events (credential_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credential_audit_events_project_idx
  ON credential_audit_events (project_id, created_at DESC);

COMMENT ON TABLE credential_audit_events IS
  'Credential vault audit trail. Stores identifiers, targets, statuses, and errors; never secret values.';
