-- 166: Short-lived, read-only permanent deletion preview intents.
CREATE TABLE IF NOT EXISTS agent_purge_preview_intents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_hash TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  impact_snapshot JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_purge_preview_intents_expiry
  ON agent_purge_preview_intents (expires_at);
