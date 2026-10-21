-- 213: Provider-neutral DecisionSpec revisions and fail-closed Project/Agent bindings.
CREATE TABLE IF NOT EXISTS decision_spec_versions (
  spec_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  spec JSONB NOT NULL,
  spec_hash TEXT NOT NULL CHECK (spec_hash ~ '^[a-f0-9]{64}$'),
  published_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(spec_id, revision),
  UNIQUE(spec_id, revision, spec_hash)
);

CREATE TABLE IF NOT EXISTS decision_spec_bindings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('project','agent')),
  principal_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  spec_revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  bound_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY(project_id, principal_type, principal_id, spec_id, spec_revision),
  FOREIGN KEY(spec_id, spec_revision) REFERENCES decision_spec_versions(spec_id, revision) ON DELETE RESTRICT,
  CHECK ((state = 'active' AND revoked_at IS NULL) OR (state = 'revoked' AND revoked_at IS NOT NULL)),
  CHECK (principal_type <> 'project' OR principal_id = project_id)
);

CREATE INDEX IF NOT EXISTS idx_decision_spec_bindings_active_lookup
  ON decision_spec_bindings(project_id, principal_type, principal_id, spec_id, spec_revision)
  WHERE state = 'active';
