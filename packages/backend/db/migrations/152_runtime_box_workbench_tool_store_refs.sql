-- 152: Tower-managed Workbench tool store references and per-Box projection observations.

ALTER TABLE runtime_box_workbench_tool_revisions
  ADD COLUMN IF NOT EXISTS storage_kind TEXT NOT NULL DEFAULT 'project-prefix'
    CHECK (storage_kind IN ('project-prefix', 'tower-managed-v1')),
  ADD COLUMN IF NOT EXISTS store_ref TEXT,
  ADD COLUMN IF NOT EXISTS store_manifest_hash TEXT;

ALTER TABLE runtime_box_workbench_tool_states
  ADD COLUMN IF NOT EXISTS projection_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS storage_mode TEXT NOT NULL DEFAULT 'project-prefix'
    CHECK (storage_mode IN ('project-prefix', 'tower-managed-v1'));

CREATE TABLE IF NOT EXISTS runtime_box_workbench_tool_projections (
  box_id BIGINT PRIMARY KEY REFERENCES project_runtime_boxes(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  store_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'mounted' CHECK (status IN ('mounted', 'stale', 'unmounted', 'recovery_required')),
  mounted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(project_id, revision)
    REFERENCES runtime_box_workbench_tool_revisions(project_id, revision) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_tool_projections_project
  ON runtime_box_workbench_tool_projections(project_id, status);

COMMENT ON TABLE runtime_box_workbench_tool_projections IS
  'Observation of the immutable Workbench tool revision mounted read-only into a Runtime Box. PostgreSQL Workbench state remains the active pointer authority.';
