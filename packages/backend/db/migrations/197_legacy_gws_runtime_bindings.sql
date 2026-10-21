-- Explicit, operator-reviewed compatibility bindings. No automatic migration.
-- This is not a new sharing scope: only previously granted users may execute.
CREATE TABLE IF NOT EXISTS legacy_gws_runtime_bindings (
  credential_id TEXT PRIMARY KEY REFERENCES workspace_credentials(id) ON DELETE CASCADE,
  secret_id INTEGER NOT NULL REFERENCES secret_store(id) ON DELETE CASCADE,
  bundle_sha256 TEXT NOT NULL CHECK (bundle_sha256 ~ '^[a-f0-9]{64}$'),
  credential_path TEXT NOT NULL CHECK (credential_path ~ '^(users/[0-9]+/)?credentials[.]json$'),
  allowed_user_ids INTEGER[] NOT NULL CHECK (cardinality(allowed_user_ids) > 0),
  approved_by INTEGER NOT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled BOOLEAN NOT NULL DEFAULT true
);
COMMENT ON TABLE legacy_gws_runtime_bindings IS 'Opt-in legacy GWS execution only; frozen approved audience intersected with live secret grants and active users. Never reveal/import authority.';
