-- 118: Bind persistent channel conversations to a concrete Primary Agent.
-- Legacy @ai sessions have agent_project_id NULL and remain compatibility-only.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS channel_agent_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_channel_agent_active
  ON sessions(room_id, channel_agent_project_id)
  WHERE label = 'channel_agent' AND channel_agent_project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_channel_agent_project
  ON sessions(channel_agent_project_id, updated_at DESC)
  WHERE channel_agent_project_id IS NOT NULL;

COMMENT ON COLUMN sessions.channel_agent_project_id IS
  'Primary Agent Project selected for a people-centered channel invocation. The Session pins that Agent profile/Harness; channel audience and resource ACL are evaluated separately.';
