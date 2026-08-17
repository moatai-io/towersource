-- 112: AI Services Phase 0 persistence
-- Immutable deployment snapshots and isolated service conversations.

CREATE TABLE IF NOT EXISTS ai_services (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  owner_agent_profile_version INTEGER NOT NULL DEFAULT 0 CHECK (owner_agent_profile_version >= 0),
  service_type TEXT NOT NULL CHECK (service_type IN ('customer','partner','employee','public','api')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','active','paused','retired')),
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  maintainers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(maintainers) = 'array'),
  current_deployment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_service_deployments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  source_snapshot JSONB NOT NULL, policy_snapshot JSONB NOT NULL,
  experience_snapshot JSONB NOT NULL, evaluation_snapshot JSONB NOT NULL,
  snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved','active','superseded','revoked')),
  approved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ, deployed_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(service_id, version), UNIQUE(service_id, snapshot_hash)
);
ALTER TABLE ai_services ADD CONSTRAINT ai_services_current_deployment_fkey
  FOREIGN KEY (current_deployment_id) REFERENCES ai_service_deployments(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ai_service_channels (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('web_link','web_widget','portal','slack','teams','messaging','api','campaign_link')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled','disabled','blocked')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_deployment_id TEXT REFERENCES ai_service_deployments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(service_id, name)
);

CREATE TABLE IF NOT EXISTS ai_service_conversations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE RESTRICT,
  deployment_id TEXT NOT NULL REFERENCES ai_service_deployments(id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL REFERENCES ai_service_channels(id) ON DELETE RESTRICT,
  tenant_key TEXT NOT NULL, user_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','deleted')),
  retention_until TIMESTAMPTZ, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_service_conversation_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id TEXT NOT NULL REFERENCES ai_service_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')), content JSONB NOT NULL,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE RESTRICT,
  deployment_id TEXT NOT NULL REFERENCES ai_service_deployments(id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL REFERENCES ai_service_channels(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_service_audit_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE CASCADE,
  deployment_id TEXT REFERENCES ai_service_deployments(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES ai_service_channels(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_deployments_one_active ON ai_service_deployments(service_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ai_conversations_isolation ON ai_service_conversations(service_id, tenant_key, user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_audit_service_created ON ai_service_audit_events(service_id, created_at DESC);

CREATE OR REPLACE FUNCTION ai_service_deployment_snapshots_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.service_id IS DISTINCT FROM OLD.service_id OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot
    OR NEW.experience_snapshot IS DISTINCT FROM OLD.experience_snapshot OR NEW.evaluation_snapshot IS DISTINCT FROM OLD.evaluation_snapshot
    OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash THEN
    RAISE EXCEPTION 'AI service deployment snapshots are immutable';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_ai_service_deployment_immutable ON ai_service_deployments;
CREATE TRIGGER trg_ai_service_deployment_immutable BEFORE UPDATE ON ai_service_deployments
FOR EACH ROW EXECUTE FUNCTION ai_service_deployment_snapshots_immutable();
