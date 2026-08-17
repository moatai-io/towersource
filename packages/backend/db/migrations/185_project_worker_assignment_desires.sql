-- Restart-safe desired-state ledger for automatic sticky Project→Worker assignment.
-- A Project remains on Runtime Box compatibility until a host reconciler prepares
-- Worker scope/filesystem access and marks the assignment active with its binding.

CREATE TABLE IF NOT EXISTS project_worker_assignment_desires (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL CHECK (deployment_id ~ '^[A-Za-z0-9._-]{1,120}$'),
  desired_worker_id TEXT NOT NULL REFERENCES runtime_box_workbench_workers(worker_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','preparing','active','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  reason TEXT,
  last_error TEXT,
  requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY(project_id,deployment_id)
);

CREATE INDEX IF NOT EXISTS idx_project_worker_assignment_desires_pending
  ON project_worker_assignment_desires(deployment_id,status,updated_at)
  WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS idx_project_worker_assignment_desires_lease
  ON project_worker_assignment_desires(lease_expires_at)
  WHERE status='preparing';
