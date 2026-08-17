/**
 * Owns: explicit Agent availability in a channel.
 * Invitation never grants Project or Harness capability.
 */
import { getPgPool } from '../../db/pg.js';

export interface ChannelAgentMembership {
  projectId: string;
  displayName: string;
  face: string;
  tagline: string | null;
  invitedBy: number | null;
  createdAt: string;
}

function rowToMembership(row: any): ChannelAgentMembership {
  return {
    projectId: row.agent_project_id,
    displayName: row.display_name,
    face: row.face || '✨',
    tagline: row.tagline || null,
    invitedBy: row.invited_by ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** List active concrete Agents invited to a channel. */
export async function listChannelAgents(channelId: string): Promise<ChannelAgentMembership[]> {
  const { rows } = await getPgPool().query(
    `SELECT cam.agent_project_id, cam.invited_by, cam.created_at,
            COALESCE(NULLIF(pap.display_name, ''), p.name) AS display_name,
            COALESCE(NULLIF(pap.face, ''), '✨') AS face,
            pap.tagline
       FROM channel_agent_memberships cam
       JOIN projects p ON p.id = cam.agent_project_id
       LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
      WHERE cam.channel_id = $1
        AND cam.revoked_at IS NULL
        AND COALESCE(pap.status, 'active') IN ('active', 'ready')
      ORDER BY cam.created_at ASC`,
    [channelId],
  );
  return rows.map(rowToMembership);
}

/** Invite an Agent for discovery/invocation in this channel. */
export async function inviteChannelAgent(input: {
  channelId: string;
  agentProjectId: string;
  invitedBy: number;
}): Promise<ChannelAgentMembership> {
  const { rows } = await getPgPool().query(
    `INSERT INTO channel_agent_memberships (channel_id, agent_project_id, invited_by, revoked_at)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (channel_id, agent_project_id)
     DO UPDATE SET invited_by = EXCLUDED.invited_by, created_at = NOW(), revoked_at = NULL
     RETURNING *`,
    [input.channelId, input.agentProjectId, input.invitedBy],
  );
  const memberships = await listChannelAgents(input.channelId);
  const membership = memberships.find((item) => item.projectId === input.agentProjectId);
  if (!membership) throw new Error('Invited Agent is not active');
  return membership;
}

/** Revoke channel availability without changing the Agent Project. */
export async function removeChannelAgent(channelId: string, agentProjectId: string): Promise<boolean> {
  const result = await getPgPool().query(
    `UPDATE channel_agent_memberships
        SET revoked_at = NOW()
      WHERE channel_id = $1 AND agent_project_id = $2 AND revoked_at IS NULL`,
    [channelId, agentProjectId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Check availability at invocation time; UI filtering alone is not a security boundary. */
export async function isAgentInvitedToChannel(channelId: string, agentProjectId: string): Promise<boolean> {
  const { rows } = await getPgPool().query(
    `SELECT 1 FROM channel_agent_memberships
      WHERE channel_id = $1 AND agent_project_id = $2 AND revoked_at IS NULL`,
    [channelId, agentProjectId],
  );
  return rows.length > 0;
}
