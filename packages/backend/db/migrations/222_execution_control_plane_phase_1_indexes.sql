-- 222: Execution Control Plane Phase 1 — indexes after additive schema commit.
-- Kept separate from 221 so schema-change locks are released before index builds.

CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_idempotency
  ON executions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_executions_source
  ON executions(source_kind, source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_non_terminal
  ON executions(status, updated_at)
  WHERE status IN ('queued','admitted','starting','running','waiting_approval');
CREATE INDEX IF NOT EXISTS idx_executions_session
  ON executions(session_id) WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_execution_events_execution_time
  ON execution_events(execution_id, occurred_at ASC, id ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_execution
  ON automation_runs(execution_id) WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_process_events_execution_time
  ON process_events(execution_id, occurred_at DESC) WHERE execution_id IS NOT NULL;
