import { beforeEach, expect, it, vi } from 'vitest';
import { query } from '../../db/pg-repo.js';
import { requireAgentWorkspaceAccess } from './access.js';
import { listAgentWorkspaceInventory } from './workspace-inventory.js';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
vi.mock('./access.js', () => ({ requireAgentWorkspaceAccess: vi.fn() }));
const input = { userId: 1, agentProjectId: 'a' };
const access = { workspaceKind: 'project', ownerProjectId: 'b', grantVersion: 1, mode: 'read-write' } as any;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(query).mockResolvedValue([{ id: 'wb' }]);
  vi.mocked(requireAgentWorkspaceAccess).mockResolvedValue(access);
});
it('queries only the receiving Agent and returns no host locator', async () => {
  expect(await listAgentWorkspaceInventory(input)).toEqual([{ workspaceId: 'wb', workspaceKind: 'project', ownerProjectId: 'b', grantVersion: 1, readOnly: false }]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('g.agent_project_id=$1'), ['a']);
  expect(vi.mocked(query).mock.calls[0][0]).not.toMatch(/RECURSIVE/i);
});
it.each(['AGENT_WRITE_DENIED', 'WORKSPACE_READ_ONLY'])('retains read-only restriction: %s', async error => {
  vi.mocked(requireAgentWorkspaceAccess).mockResolvedValueOnce(access).mockRejectedValueOnce(new Error(error));
  expect((await listAgentWorkspaceInventory(input))[0].readOnly).toBe(true);
});
it('fails rather than returning a partial list after revocation', async () => {
  vi.mocked(requireAgentWorkspaceAccess).mockResolvedValueOnce(access).mockRejectedValueOnce(new Error('WORKSPACE_NOT_GRANTED'));
  await expect(listAgentWorkspaceInventory(input)).rejects.toThrow('NOT_GRANTED');
});
it('rejects changed grant versions between checks', async () => {
  vi.mocked(requireAgentWorkspaceAccess).mockResolvedValueOnce(access).mockResolvedValueOnce({ ...access, grantVersion: 2 });
  await expect(listAgentWorkspaceInventory(input)).rejects.toThrow('INVENTORY_CHANGED');
});
it('bounds inventory rather than silently truncating grants', async () => {
  vi.mocked(query).mockResolvedValue(Array.from({ length: 257 }, (_, i) => ({ id: String(i) })));
  await expect(listAgentWorkspaceInventory(input)).rejects.toThrow('INVENTORY_LIMIT');
  expect(requireAgentWorkspaceAccess).not.toHaveBeenCalled();
});
