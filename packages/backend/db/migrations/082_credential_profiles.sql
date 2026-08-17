-- 082_credential_profiles.sql — Credential Profile / env bundle support
--
-- Profiles package non-secret env plus secret credential references into one
-- project-granted connection bundle. Example: LiteLLM profile injects
-- LLM_BACKEND/LITELLM_BASE_URL/MODEL_* plus LITELLM_API_KEY from a Vault credential.

CREATE TABLE IF NOT EXISTS credential_profiles (
  id             TEXT PRIMARY KEY,
  profile_type   TEXT NOT NULL,                       -- llm_backend | cli_profile | cloud_account | ssh_connection | custom
  provider       TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  env            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- non-secret env: {"LLM_BACKEND":"litellm"}
  secret_refs    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- env -> credential id: {"LITELLM_API_KEY":"litellm-veritas"}
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     INT REFERENCES users(id),

  CONSTRAINT credential_profiles_id_chk CHECK (id ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  CONSTRAINT credential_profiles_type_chk CHECK (
    profile_type IN ('llm_backend', 'cli_profile', 'cloud_account', 'ssh_connection', 'custom')
  )
);

CREATE INDEX IF NOT EXISTS credential_profiles_provider_idx
  ON credential_profiles (provider, profile_type)
  WHERE enabled = true;

COMMENT ON TABLE credential_profiles IS
  'Credential profiles package non-secret env and secret credential references into project-granted connection bundles.';
COMMENT ON COLUMN credential_profiles.env IS
  'Non-secret environment variables only. Do not store API keys or tokens here.';
COMMENT ON COLUMN credential_profiles.secret_refs IS
  'Map of runtime env name to workspace_credentials.id. Secret values remain in secret_store.';

CREATE TABLE IF NOT EXISTS project_credential_profile_policies (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id   TEXT NOT NULL REFERENCES credential_profiles(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL DEFAULT 'allow',          -- allow | deny
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   INT REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   INT REFERENCES users(id),
  PRIMARY KEY (project_id, profile_id),
  CONSTRAINT project_credential_profile_policies_mode_chk CHECK (mode IN ('allow', 'deny'))
);

CREATE INDEX IF NOT EXISTS project_credential_profile_policies_project_idx
  ON project_credential_profile_policies (project_id, mode);

COMMENT ON TABLE project_credential_profile_policies IS
  'Per-project allow/deny policy for credential profiles.';
