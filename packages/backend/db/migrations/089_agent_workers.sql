-- 089: Agent Control Plane MVP — persistent workers, runs, state cards, events
--
-- This is the smallest dogfooding slice from:
--   workspace/decisions/2026-06-13-agent-control-plane-unification.md
--
-- Rollback:
--   DROP TABLE IF EXISTS agent_events;
--   DROP TABLE IF EXISTS agent_state_cards;
--   DROP TABLE IF EXISTS agent_runs;
--   DROP TABLE IF EXISTS agent_workers;

CREATE TABLE IF NOT EXISTS agent_workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'persistent',
  status TEXT NOT NULL DEFAULT 'idle',
  visibility TEXT NOT NULL DEFAULT 'background',

  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  project_id TEXT REFERENCES projects(id),
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  backing_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  goal_id TEXT,

  role TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_workers_owner_updated
  ON agent_workers(owner_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_workers_project_updated
  ON agent_workers(project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_workers_parent_updated
  ON agent_workers(parent_session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_workers_backing_session
  ON agent_workers(backing_session_id)
  WHERE backing_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES agent_workers(id) ON DELETE CASCADE,
  parent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL DEFAULT 'user',
  input TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  model TEXT,
  result_summary TEXT,
  artifact_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  cost_estimate REAL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_worker_created
  ON agent_runs(worker_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created
  ON agent_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_state_cards (
  worker_id TEXT PRIMARY KEY REFERENCES agent_workers(id) ON DELETE CASCADE,
  goal TEXT NOT NULL DEFAULT '',
  current_focus TEXT NOT NULL DEFAULT '',
  last_action TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  important_artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  source_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence TEXT,
  stale_after TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_state_cards_updated
  ON agent_state_cards(updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  worker_id TEXT REFERENCES agent_workers(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  owner_user_id INTEGER REFERENCES users(id),
  project_id TEXT REFERENCES projects(id),
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_worker_created
  ON agent_events(worker_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_events_owner_created
  ON agent_events(owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_events_session_created
  ON agent_events(session_id, created_at DESC);
