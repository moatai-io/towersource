-- 170: Durable Remote Workbench Worker registry for control-plane scheduling.
CREATE TABLE IF NOT EXISTS runtime_box_workbench_workers (
  worker_id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  capabilities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  project_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  cpu_total INTEGER NOT NULL DEFAULT 0,
  memory_mb_total INTEGER NOT NULL DEFAULT 0,
  active_runs INTEGER NOT NULL DEFAULT 0,
  max_runs INTEGER NOT NULL,
  draining BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_box_workbench_workers_capacity_chk
    CHECK (cpu_total >= 0 AND memory_mb_total >= 0 AND active_runs >= 0 AND max_runs >= 1 AND active_runs <= max_runs),
  CONSTRAINT runtime_box_workbench_workers_url_chk
    CHECK (base_url ~ '^https?://')
);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_workers_heartbeat
  ON runtime_box_workbench_workers (heartbeat_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_workers_schedulable
  ON runtime_box_workbench_workers (draining, active_runs, max_runs, heartbeat_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_workers_projects_gin
  ON runtime_box_workbench_workers USING GIN (project_ids);

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_workers_capabilities_gin
  ON runtime_box_workbench_workers USING GIN (capabilities);
