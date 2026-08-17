import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryOne, poolQuery } = vi.hoisted(() => ({ queryOne: vi.fn(), poolQuery: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne, query: vi.fn(), execute: vi.fn() }));
vi.mock('../../db/pg.js', () => ({ getPgPool: () => ({ query: poolQuery }) }));
vi.mock('../pm/project-membership-manager.js', () => ({ getAccessibleProjectIds: vi.fn() }));
vi.mock('../session/short-code.js', () => ({ generateShortCode: () => 'abcdefgh' }));

import { ChannelNameConflictError, createRoom, normalizeChannelName, updateRoom } from './room-manager.js';

describe('people-centered channel name contract', () => {
  beforeEach(() => { queryOne.mockReset(); poolQuery.mockReset(); });

  it('normalizes case and repeated whitespace', () => {
    expect(normalizeChannelName('  TownHall   Korea ')).toBe('townhall korea');
  });

  it('blocks a new active user channel with the same normalized name', async () => {
    queryOne.mockResolvedValueOnce({ id: 'existing', name: 'townhall' });
    await expect(createRoom(' TownHall ', null, 'team', 1)).rejects.toBeInstanceOf(ChannelNameConflictError);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('allows renaming a channel to its own normalized name', async () => {
    queryOne.mockResolvedValueOnce(null);
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'r1', name: 'Town Hall', room_type: 'team', kind: 'user', archived: 0, created_by: 1, created_at: new Date(), updated_at: new Date() }] });
    await expect(updateRoom('r1', { name: '  Town   Hall  ' })).resolves.toMatchObject({ name: 'Town Hall' });
    expect(queryOne.mock.calls[0][1]).toEqual(['town hall', 'r1']);
  });
});
