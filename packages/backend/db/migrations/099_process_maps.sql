-- 099: Process Map MVP
-- Store normalized process events and optional graph snapshots separately from TodoWrite.

CREATE TABLE IF NOT EXISTS process_events (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id    TEXT,
  session_id    TEXT,
  automation_id TEXT REFERENCES automations(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES automation_runs(id) ON DELETE CASCADE,

  source_type   TEXT NOT NULL,
  source_id     TEXT,
  event_type    TEXT NOT NULL,
  raw_label     TEXT,
  raw_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_process_events_project_time ON process_events(project_id, occurred_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_process_events_session_time ON process_events(session_id, occurred_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_process_events_automation_time ON process_events(automation_id, occurred_at DESC)
  WHERE automation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_process_events_run_time ON process_events(run_id, occurred_at DESC)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_process_events_source ON process_events(source_type, source_id)
  WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS process_maps (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id         TEXT,
  title              TEXT NOT NULL,
  source             TEXT NOT NULL,
  abstraction_level  TEXT NOT NULL DEFAULT 'run',
  status             TEXT NOT NULL DEFAULT 'draft',
  source_refs        JSONB NOT NULL DEFAULT '{}'::jsonb,
  nodes              JSONB NOT NULL DEFAULT '[]'::jsonb,
  edges              JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_process_maps_project_updated ON process_maps(project_id, updated_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_process_maps_source ON process_maps(source, abstraction_level);
