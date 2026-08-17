-- 163: Lease/heartbeat evidence for background Workbench Job runners.

ALTER TABLE runtime_box_workbench_jobs
  ADD COLUMN IF NOT EXISTS claim_token TEXT,
  ADD COLUMN IF NOT EXISTS runner_id TEXT,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0;

ALTER TABLE runtime_box_workbench_jobs
  ADD CONSTRAINT runtime_box_workbench_jobs_attempt_check CHECK (attempt >= 0);
