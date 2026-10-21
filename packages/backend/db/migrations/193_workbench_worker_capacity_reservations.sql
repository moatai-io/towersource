-- Track transient Worker capacity per execution so orphaned reservations can expire
-- and active_runs can be reconciled from durable, inspectable state.
CREATE TABLE IF NOT EXISTS runtime_box_workbench_worker_capacity_reservations (
  reservation_id UUID PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES runtime_box_workbench_workers(worker_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT,
  job_id BIGINT,
  weight INTEGER NOT NULL CHECK (weight > 0 AND weight <= 1000),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','released','expired')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CHECK (expires_at > reserved_at),
  CHECK ((state = 'reserved' AND released_at IS NULL) OR (state <> 'reserved' AND released_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_workbench_capacity_reservations_worker_live
  ON runtime_box_workbench_worker_capacity_reservations(worker_id, expires_at)
  WHERE state = 'reserved';

CREATE INDEX IF NOT EXISTS idx_workbench_capacity_reservations_session
  ON runtime_box_workbench_worker_capacity_reservations(session_id, reserved_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workbench_capacity_reservations_job
  ON runtime_box_workbench_worker_capacity_reservations(job_id)
  WHERE job_id IS NOT NULL;
