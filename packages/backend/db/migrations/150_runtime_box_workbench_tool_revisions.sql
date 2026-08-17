-- 150: Project-scoped managed Workbench tool revisions and current pointer.

CREATE TABLE IF NOT EXISTS runtime_box_workbench_tool_states (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  current_revision INTEGER,
  health TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','degraded','recovery_required')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS runtime_box_workbench_tool_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('staging','prepared','active','superseded','failed','rollback')),
  previous_revision INTEGER,
  source_revision INTEGER,
  manager TEXT NOT NULL CHECK (manager IN ('uv-tool')),
  manifest JSONB NOT NULL,
  manifest_hash TEXT NOT NULL,
  prefix_relpath TEXT NOT NULL CHECK (prefix_relpath ~ '^\.runtime-box/workbench-tools/revisions/[0-9]{6}$'),
  validation JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL DEFAULT 'install',
  job_id TEXT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  requested_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  PRIMARY KEY(project_id, revision),
  FOREIGN KEY(project_id, previous_revision)
    REFERENCES runtime_box_workbench_tool_revisions(project_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY(project_id, source_revision)
    REFERENCES runtime_box_workbench_tool_revisions(project_id, revision) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_box_workbench_one_active_tool_revision
  ON runtime_box_workbench_tool_revisions(project_id) WHERE state='active';
CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_tool_revisions_recent
  ON runtime_box_workbench_tool_revisions(project_id, revision DESC);

ALTER TABLE runtime_box_workbench_tool_states
  ADD CONSTRAINT runtime_box_workbench_tool_current_revision_fkey
  FOREIGN KEY(project_id, current_revision)
  REFERENCES runtime_box_workbench_tool_revisions(project_id, revision) ON DELETE RESTRICT;
