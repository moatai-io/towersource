-- 162: Durable Project-scoped execution registry for Agent Workbench jobs.
-- Execution is provider-neutral; the first runner_kind is local-runtime.

CREATE TABLE IF NOT EXISTS runtime_box_workbench_jobs (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  box_id BIGINT REFERENCES project_runtime_boxes(id) ON DELETE SET NULL,
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_by_session_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  runner_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT,
  timeout_seconds INTEGER,
  environment_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  workbench_revision INTEGER,
  exit_code INTEGER,
  stdout_text TEXT,
  stderr_text TEXT,
  result_json JSONB,
  error_code TEXT,
  error_summary TEXT,
  cancel_requested_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_box_workbench_jobs_provider_check CHECK (provider_kind IN ('local-runtime', 'remote-worker')),
  CONSTRAINT runtime_box_workbench_jobs_runner_check CHECK (runner_kind IN ('local-process', 'remote-worker')),
  CONSTRAINT runtime_box_workbench_jobs_status_check CHECK (status IN ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT runtime_box_workbench_jobs_timeout_check CHECK (timeout_seconds IS NULL OR timeout_seconds BETWEEN 1 AND 3600),
  CONSTRAINT runtime_box_workbench_jobs_revision_check CHECK (workbench_revision IS NULL OR workbench_revision >= 0),
  CONSTRAINT runtime_box_workbench_jobs_environment_keys_check CHECK (jsonb_typeof(environment_keys) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_jobs_project_created
  ON runtime_box_workbench_jobs(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_jobs_active
  ON runtime_box_workbench_jobs(project_id, status, created_at)
  WHERE status IN ('queued', 'running', 'cancel_requested');

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_jobs_session
  ON runtime_box_workbench_jobs(requested_by_session_id, created_at DESC);
