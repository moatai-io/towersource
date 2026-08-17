-- 145: Server-stored, short-lived automation change previews with one-time apply.

CREATE TABLE IF NOT EXISTS automation_change_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  proposed_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  base_config_updated_at TIMESTAMPTZ NOT NULL,
  proposal_hash TEXT NOT NULL,
  yaml_text TEXT NOT NULL,
  materialized_updates JSONB NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applying','applied','rejected','expired','failed')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  applying_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  applying_at TIMESTAMPTZ,
  applied_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_change_intents_automation
  ON automation_change_intents(automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_change_intents_pending
  ON automation_change_intents(expires_at)
  WHERE status = 'proposed';
