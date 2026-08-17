-- 167: Durable audit/state record for permanent Agent deletion.
CREATE TABLE IF NOT EXISTS agent_purge_jobs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  project_id_snapshot TEXT NOT NULL,
  project_name_snapshot TEXT NOT NULL,
  root_path_snapshot TEXT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  preview_intent_id TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  stage TEXT NOT NULL DEFAULT 'approved',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  quarantine_path TEXT,
  impact_snapshot JSONB NOT NULL,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_purge_jobs_status_chk CHECK (status IN (
    'approved','running','completed','failed_before_destructive','recovery_required'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_purge_jobs_preview_intent
  ON agent_purge_jobs (preview_intent_id);
CREATE INDEX IF NOT EXISTS idx_agent_purge_jobs_status_updated
  ON agent_purge_jobs (status, updated_at DESC);
