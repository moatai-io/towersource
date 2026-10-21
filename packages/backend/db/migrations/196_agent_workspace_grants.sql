-- Additive authority vocabulary. No automatic cross-Agent sharing or storage relocation.
CREATE TABLE IF NOT EXISTS agent_workspaces (
  id TEXT PRIMARY KEY,
  owner_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'shared-skills')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  CHECK ((kind = 'project' AND owner_project_id IS NOT NULL) OR (kind = 'shared-skills' AND owner_project_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_workspaces_project_owner ON agent_workspaces(owner_project_id) WHERE kind = 'project';
CREATE TABLE IF NOT EXISTS agent_workspace_grants (
  agent_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'read-write')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_project_id, workspace_id)
);
-- Provisioning, delegation authorization and storage mounting are separate activation steps.
