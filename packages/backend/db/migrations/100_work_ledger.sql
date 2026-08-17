-- 100: WorkLedger / RunLedger canonical records
--
-- Trackable work should not depend on TodoWrite tool_use snapshots forever.
-- This table is the canonical run/workstream ledger; TodoWrite, ProcessMapWrite,
-- command invocations, schedules, and agent runs can all attach as sources.
-- See: workspace/decisions/2026-07-01-process-map-as-automation-seed.md

CREATE TABLE IF NOT EXISTS work_ledger_records (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id                TEXT NOT NULL,
  project_id            TEXT,
  session_id            TEXT,
  owner_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,

  workstream_key         TEXT NOT NULL,
  workstream_title       TEXT,
  run_title              TEXT NOT NULL,
  outcome                TEXT,
  note                   TEXT,

  source_type            TEXT NOT NULL
                         CHECK (source_type IN ('command_invocation', 'process_map', 'todowrite', 'schedule_run', 'agent_run', 'manual')),
  source_id              TEXT NOT NULL DEFAULT '',
  source_refs            JSONB NOT NULL DEFAULT '{}'::jsonb,

  status                 TEXT NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'completed', 'blocked', 'failed', 'cancelled')),
  artifacts              JSONB NOT NULL DEFAULT '[]'::jsonb,
  backlog                JSONB NOT NULL DEFAULT '[]'::jsonb,
  questions              JSONB NOT NULL DEFAULT '[]'::jsonb,

  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_ledger_run_source
  ON work_ledger_records (run_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_work_ledger_project_updated
  ON work_ledger_records (project_id, updated_at DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_ledger_session_updated
  ON work_ledger_records (session_id, updated_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_ledger_workstream_updated
  ON work_ledger_records (project_id, workstream_key, updated_at DESC);

CREATE OR REPLACE FUNCTION work_ledger_records_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_work_ledger_records_touch ON work_ledger_records;
CREATE TRIGGER trg_work_ledger_records_touch
  BEFORE UPDATE ON work_ledger_records
  FOR EACH ROW EXECUTE FUNCTION work_ledger_records_touch_updated_at();
