-- 119: Agents explicitly invited to people-centered channels.
-- Invitation controls discovery/invocation only; it never grants Project access.
CREATE TABLE IF NOT EXISTS channel_agent_memberships (
  channel_id       TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  agent_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invited_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at       TIMESTAMPTZ,
  PRIMARY KEY (channel_id, agent_project_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_agent_memberships_agent
  ON channel_agent_memberships(agent_project_id, channel_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE channel_agent_memberships IS
  'Primary Agents invited to a channel. Availability only: effective execution still intersects Agent Harness, caller authority, channel audience, linked resources, and Project ACL.';
