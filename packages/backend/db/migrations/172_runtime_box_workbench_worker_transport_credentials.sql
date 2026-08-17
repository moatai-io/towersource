-- 172: Bind Worker execution transport authentication to an encrypted Secret Store reference.
-- This table stores only a secret name, never bearer token material.
CREATE TABLE IF NOT EXISTS runtime_box_workbench_worker_transport_credentials (
  worker_id TEXT PRIMARY KEY REFERENCES runtime_box_workbench_workers(worker_id) ON DELETE CASCADE,
  secret_name TEXT NOT NULL,
  configured_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  configured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_box_workbench_worker_transport_secret_name_chk
    CHECK (secret_name ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

COMMENT ON TABLE runtime_box_workbench_worker_transport_credentials IS
  'Non-secret mapping from Worker id to encrypted Secret Store name; no bearer value is stored here.';
