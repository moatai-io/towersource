-- 124: Idempotent Primary Agent creation command and resource provenance.

CREATE TABLE IF NOT EXISTS primary_agent_creation_commands (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  approved_card_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN (
    'reserved','provisioning_project','provisioning_profile','binding_harness',
    'provisioning_files','creating_session','ready','failed','cleanup_pending','cleaned','cleanup_failed'
  )),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  harness_id TEXT,
  harness_version INTEGER,
  runtime_profile_id TEXT,
  runtime_profile_version INTEGER,
  result JSONB,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE(actor_user_id,idempotency_key)
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS creation_command_id TEXT REFERENCES primary_agent_creation_commands(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_creation_command_id TEXT REFERENCES primary_agent_creation_commands(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_creation_command_unique ON projects(creation_command_id) WHERE creation_command_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_agent_creation_command_unique ON sessions(agent_creation_command_id) WHERE agent_creation_command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_primary_agent_commands_status ON primary_agent_creation_commands(status,updated_at DESC);

CREATE TABLE IF NOT EXISTS primary_agent_creation_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  command_id TEXT NOT NULL REFERENCES primary_agent_creation_commands(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_primary_agent_creation_events_command ON primary_agent_creation_events(command_id,created_at);
