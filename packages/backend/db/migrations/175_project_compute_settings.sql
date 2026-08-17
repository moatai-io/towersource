-- Project compute settings for Worker-first execution.
-- Stores scheduling preferences only. Worker execution authority still comes
-- from runtime_box_workbench_workers scope/capability/heartbeat/capacity plus transport auth.

CREATE TABLE IF NOT EXISTS project_compute_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  default_worker_id TEXT NULL REFERENCES runtime_box_workbench_workers(worker_id) ON DELETE SET NULL,
  workstation_mode BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_compute_settings_default_worker
  ON project_compute_settings(default_worker_id)
  WHERE default_worker_id IS NOT NULL;
