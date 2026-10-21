-- 221: Execution Control Plane Phase 1 — additive run lifecycle ledger.
-- Existing Task, Automation Run, Agent Run and side-effect ledgers remain intact.

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('automation','manual','agent','webhook','system')),
  source_id TEXT,
  source_run_id TEXT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project','system','personal')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued','admitted','starting','running','waiting_approval',
    'succeeded','failed','cancelled','timed_out','uncertain'
  )),
  adapter_kind TEXT NOT NULL CHECK (adapter_kind IN (
    'legacy_task','ai_session','runtime_box','webhook','host','system'
  )),
  engine TEXT,
  model TEXT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  executor_ref TEXT,
  parent_execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  idempotency_key TEXT NOT NULL,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB,
  summary_text TEXT,
  error_json JSONB,
  admitted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (scope_kind = 'project' AND project_id IS NOT NULL)
    OR
    (scope_kind IN ('system','personal') AND project_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS execution_events (
  id BIGSERIAL PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL;

ALTER TABLE process_events
  ADD COLUMN IF NOT EXISTS execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL;
