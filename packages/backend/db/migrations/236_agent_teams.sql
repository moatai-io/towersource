-- Team affiliation is canonical membership data, not an ACL or Session audience.
-- Additive only: no backfill, legacy grants/settings changes, triggers or storage moves.
CREATE TABLE IF NOT EXISTS agent_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS agent_team_members (
  team_id TEXT NOT NULL REFERENCES agent_teams(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  PRIMARY KEY (team_id, user_id)
);

-- A person may join multiple teams; an Agent has at most one primary team.
-- Unassigned existing Agents remain teamless until explicitly assigned.
CREATE TABLE IF NOT EXISTS agent_team_projects (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  team_id TEXT NOT NULL REFERENCES agent_teams(id)
);
-- Default NO ACTION foreign keys deliberately avoid cascading affiliation deletion.
-- Disable memberships/teams explicitly; provisioning and admission are separate steps.
