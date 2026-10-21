import { beforeEach, expect, it, vi } from 'vitest';
import { queryOne } from '../../db/pg-repo.js';
import { canAccessSession } from '../pm/project-access.js';
import { readAgentWorkspaceRequest } from './read-request.js';
import { readSessionAgentWorkspaceFile } from './session-read.js';
vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: vi.fn() }));
vi.mock('./read-request.js', () => ({ readAgentWorkspaceRequest: vi.fn() }));
const input = { userId: 1, sessionId: 's1', body: { ref: { agentProjectId: 'a', workspaceId: 'w', relativePath: 'file.txt' } } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(queryOne).mockResolvedValueOnce({ role: 'member', disabled: 0 }).mockResolvedValueOnce({ project_id: 'a' }).mockResolvedValueOnce({ project_id: 'a' });
  vi.mocked(canAccessSession).mockResolvedValue({ allowed: true });
});
it('derives Agent from the stored session and uses the current user role', async () => {
  await readSessionAgentWorkspaceFile(input);
  expect(canAccessSession).toHaveBeenCalledWith('s1', 1, 'member');
  expect(readAgentWorkspaceRequest).toHaveBeenCalledWith({ userId: 1, agentProjectId: 'a' }, input.body);
});
it('rejects private/inaccessible sessions before file access', async () => {
  vi.mocked(canAccessSession).mockResolvedValue({ allowed: false, status: 403, message: 'private' });
  await expect(readSessionAgentWorkspaceFile(input)).rejects.toThrow('SESSION_ACCESS_DENIED');
  expect(readAgentWorkspaceRequest).not.toHaveBeenCalled();
});
it('rejects disabled users before session authorization', async () => {
  vi.mocked(queryOne).mockReset().mockResolvedValueOnce({ role: 'admin', disabled: 1 });
  await expect(readSessionAgentWorkspaceFile(input)).rejects.toThrow('USER_INACTIVE');
  expect(canAccessSession).not.toHaveBeenCalled();
});
it.each([null, 'b'])('rejects a removed or moved session (%s)', async projectId => {
  vi.mocked(queryOne).mockReset().mockResolvedValueOnce({ role: 'member', disabled: 0 }).mockResolvedValueOnce({ project_id: 'a' }).mockResolvedValueOnce({ project_id: projectId });
  await expect(readSessionAgentWorkspaceFile(input)).rejects.toThrow('SESSION_CHANGED');
  expect(readAgentWorkspaceRequest).not.toHaveBeenCalled();
});
it('does not treat session sharing as a workspace grant', async () => {
  vi.mocked(readAgentWorkspaceRequest).mockRejectedValue(new Error('WORKSPACE_NOT_GRANTED'));
  await expect(readSessionAgentWorkspaceFile(input)).rejects.toThrow('WORKSPACE_NOT_GRANTED');
});
