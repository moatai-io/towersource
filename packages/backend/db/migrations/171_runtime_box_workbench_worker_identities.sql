-- 171: Audit and revocation registry for expiring Workbench Worker identities.
-- Raw JWT values are never stored; jti is the revocation handle.
CREATE TABLE IF NOT EXISTS runtime_box_workbench_worker_identities (
  jti TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  project_ids TEXT[] NOT NULL,
  capabilities TEXT[] NOT NULL,
  issued_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_jti TEXT REFERENCES runtime_box_workbench_worker_identities(jti) ON DELETE SET NULL,
  reason TEXT,
  CONSTRAINT runtime_box_workbench_worker_identity_scope_chk
    CHECK (cardinality(project_ids) > 0 AND cardinality(capabilities) > 0),
  CONSTRAINT runtime_box_workbench_worker_identity_expiry_chk
    CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_worker_identities_worker
  ON runtime_box_workbench_worker_identities (worker_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_worker_identities_active
  ON runtime_box_workbench_worker_identities (worker_id, expires_at DESC)
  WHERE revoked_at IS NULL;
