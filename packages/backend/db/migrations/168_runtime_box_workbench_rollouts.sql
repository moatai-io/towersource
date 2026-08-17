-- 168: Restart-free Project rollout registry for the Agent Workbench beta.
CREATE TABLE IF NOT EXISTS runtime_box_workbench_rollouts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'disabled',
  cohort TEXT,
  reason TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_box_workbench_rollouts_status_chk
    CHECK (status IN ('enabled', 'disabled', 'observe'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_rollouts_status
  ON runtime_box_workbench_rollouts (status, updated_at DESC);
