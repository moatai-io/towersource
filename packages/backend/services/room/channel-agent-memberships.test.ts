import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgQuery = vi.fn();
vi.mock('../../db/pg.js', () => ({ getPgPool: () => ({ query: pgQuery }) }));

import { inviteChannelAgent, isAgentInvitedToChannel, listChannelAgents, removeChannelAgent } from './channel-agent-memberships.js';

const agentRow = {
  agent_project_id: 'agent-project-1', invited_by: 7,
  created_at: new Date('2026-07-13T00:00:00Z'),
  display_name: 'Tower Development', face: '🛠️', tagline: 'Builds Tower',
};

describe('channel Agent memberships', () => {
  beforeEach(() => pgQuery.mockReset());

  it('lists only active invited Agents', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [agentRow] });
    await expect(listChannelAgents('room-1')).resolves.toEqual([{
      projectId: 'agent-project-1', displayName: 'Tower Development', face: '🛠️',
      tagline: 'Builds Tower', invitedBy: 7, createdAt: '2026-07-13T00:00:00.000Z',
    }]);
    expect(pgQuery.mock.calls[0][0]).toContain('cam.revoked_at IS NULL');
  });

  it('invites availability without changing Project membership', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [agentRow] });
    await expect(inviteChannelAgent({ channelId: 'room-1', agentProjectId: 'agent-project-1', invitedBy: 7 }))
      .resolves.toMatchObject({ projectId: 'agent-project-1' });
    expect(pgQuery.mock.calls[0][0]).toContain('channel_agent_memberships');
    expect(pgQuery.mock.calls[0][0]).not.toContain('project_members');
  });

  it('checks invitation again at invocation time', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(isAgentInvitedToChannel('room-1', 'agent-project-1')).resolves.toBe(true);
  });

  it('soft revokes channel availability', async () => {
    pgQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(removeChannelAgent('room-1', 'agent-project-1')).resolves.toBe(true);
  });
});
