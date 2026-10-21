-- Explicit file storage is separate from execution placement.
-- Additive only: no automatic backfill or file movement. Existing Projects retain legacy routing.
CREATE TABLE IF NOT EXISTS project_file_storage_bindings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('host', 'worker')),
  worker_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'blocked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, deployment_id),
  CHECK ((storage_kind = 'host' AND worker_id IS NULL) OR
         (storage_kind = 'worker' AND worker_id IS NOT NULL AND length(trim(worker_id)) > 0))
);
COMMENT ON TABLE project_file_storage_bindings IS 'Explicit storage authority; ready requires verified authoritative bytes. Not Agent access grants.';
