-- 115: Separate work activity time from row maintenance time and persist TodoWrite detail.
ALTER TABLE work_ledger_records
  ADD COLUMN IF NOT EXISTS activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS todos JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE work_ledger_records
SET activity_at = COALESCE(activity_at, started_at, created_at)
WHERE activity_at IS NULL;

ALTER TABLE work_ledger_records
  ALTER COLUMN activity_at SET DEFAULT NOW(),
  ALTER COLUMN activity_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_ledger_project_activity
  ON work_ledger_records (project_id, activity_at DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_ledger_workstream_activity
  ON work_ledger_records (project_id, workstream_key, activity_at DESC);
