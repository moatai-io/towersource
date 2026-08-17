-- Deployment-scoped Worker binding for Projects sharing one Tower database.
-- Legacy project_compute_settings remains the development/default compatibility row.

CREATE TABLE IF NOT EXISTS project_compute_deployment_bindings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL CHECK (deployment_id ~ '^[A-Za-z0-9._-]{1,120}$'),
  default_worker_id TEXT NULL REFERENCES runtime_box_workbench_workers(worker_id) ON DELETE SET NULL,
  workstation_mode BOOLEAN NOT NULL DEFAULT FALSE,
  authority_mode TEXT NOT NULL DEFAULT 'project'
    CHECK (authority_mode IN ('project','operator-plane','sandbox')),
  updated_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(project_id, deployment_id)
);

CREATE INDEX IF NOT EXISTS idx_project_compute_deployment_worker
  ON project_compute_deployment_bindings(deployment_id, default_worker_id)
  WHERE default_worker_id IS NOT NULL;
