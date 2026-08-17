import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgQuery = vi.fn();

vi.mock('../../db/pg.js', () => ({
  getPgPool: () => ({ query: pgQuery }),
}));

import {
  addChannelProjectLink,
  listChannelResourceLinks,
  removeChannelProjectLink,
} from './channel-resource-links.js';

const row = {
  id: 'link-1',
  channel_id: 'room-1',
  resource_type: 'project',
  resource_id: 'project-1',
  capability: 'read',
  added_by: 7,
  created_at: new Date('2026-07-13T00:00:00Z'),
};

describe('channel resource links', () => {
  beforeEach(() => pgQuery.mockReset());

  it('lists active project links as API-shaped resources', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [row] });
    await expect(listChannelResourceLinks('room-1')).resolves.toEqual([{
      id: 'link-1',
      channelId: 'room-1',
      resourceType: 'project',
      resourceId: 'project-1',
      capability: 'read',
      addedBy: 7,
      createdAt: '2026-07-13T00:00:00.000Z',
    }]);
    expect(pgQuery.mock.calls[0][0]).toContain('revoked_at IS NULL');
  });

  it('upserts a project link without changing project membership', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [row] });
    const result = await addChannelProjectLink({
      channelId: 'room-1',
      projectId: 'project-1',
      addedBy: 7,
    });
    expect(result.capability).toBe('read');
    expect(pgQuery.mock.calls[0][0]).toContain('ON CONFLICT');
    expect(pgQuery.mock.calls[0][1]).toEqual(['room-1', 'project-1', 'read', 7]);
  });

  it('rejects unknown capabilities before querying', async () => {
    await expect(addChannelProjectLink({
      channelId: 'room-1',
      projectId: 'project-1',
      capability: 'admin' as any,
      addedBy: 7,
    })).rejects.toThrow('Invalid channel resource capability');
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('soft-revokes links so audit history remains', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(removeChannelProjectLink('room-1', 'project-1')).resolves.toBe(true);
    expect(pgQuery.mock.calls[0][0]).toContain('SET revoked_at = NOW()');
  });
});
