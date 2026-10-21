import { beforeEach, expect, it, vi } from 'vitest';
import { queryOne } from '../../db/pg-repo.js';
import { evaluateAgentWorkspaceAccess as decide, requireAgentWorkspaceAccess as requireAccess, type WorkspaceAccessFacts } from './access.js';
vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
const base: WorkspaceAccessFacts = { user_role: 'member', user_disabled: 0, agent_archived: 0, agent_status: 'active', membership_role: 'member', workspace_state: 'active', owner_project_id: 'self', owner_archived: 0, workspace_kind: 'project', grant_mode: null, grant_version: null, grant_revoked_at: null };
beforeEach(() => vi.resetAllMocks());
it('permits ordinary read and write in the own workspace', () => {
  expect(decide('self', 'read', base).mode).toBe('read-write');
  expect(decide('self', 'write', base).ownWorkspace).toBe(true);
});
it('permits only the explicitly connected workspace mode', () => {
  const other = { ...base, owner_project_id: 'a', grant_mode: 'read', grant_version: 1 };
  expect(decide('self', 'read', other).mode).toBe('read');
  expect(() => decide('self', 'write', other)).toThrow('WORKSPACE_READ_ONLY');
  expect(decide('self', 'write', { ...other, grant_mode: 'read-write' }).mode).toBe('read-write');
});
it.each(['admin', 'operator', 'member'])('does not let %s invent disconnected workspace grants', user_role => {
  expect(() => decide('self', 'read', { ...base, user_role, owner_project_id: 'c' })).toThrow('NOT_GRANTED');
});
it.each(['viewer', 'guest'])('preserves %s read-only constraints even for own workspace', user_role => {
  expect(decide('self', 'read', { ...base, user_role }).ownWorkspace).toBe(true);
  expect(() => decide('self', 'write', { ...base, user_role })).toThrow('WRITE_DENIED');
});
it('respects read-only membership and revoked grants', () => {
  expect(() => decide('self', 'write', { ...base, membership_role: 'viewer' })).toThrow('WRITE_DENIED');
  expect(() => decide('self', 'read', { ...base, owner_project_id: 'b', grant_mode: 'read-write', grant_version: 2, grant_revoked_at: '2026-01-01' })).toThrow('NOT_GRANTED');
});
it('shared skills use explicit grants and never infer ownership', () => {
  const skills = { ...base, owner_project_id: null, workspace_kind: 'shared-skills', grant_mode: 'read', grant_version: 1 };
  expect(decide('self', 'read', skills).ownWorkspace).toBe(false);
  expect(() => decide('self', 'write', skills)).toThrow('READ_ONLY');
});
it('denies inactive identities and unavailable workspaces', () => {
  for (const patch of [{ user_disabled: 1 }, { agent_archived: 1 }, { agent_status: 'paused' }, { membership_role: null }, { user_role: 'unknown' }]) expect(() => decide('self', 'read', { ...base, ...patch })).toThrow('ACCESS_DENIED');
  expect(() => decide('self', 'read', { ...base, owner_archived: 1 })).toThrow('UNAVAILABLE');
});
it('uses current direct grant rows per request without recursive inheritance', async () => {
  vi.mocked(queryOne).mockResolvedValueOnce({ ...base, owner_project_id: 'b', grant_mode: 'read', grant_version: 1 }).mockResolvedValueOnce({ ...base, owner_project_id: 'b' });
  const request = { userId: 1, agentProjectId: 'self', workspaceId: 'b-files', operation: 'read' as const };
  expect((await requireAccess(request)).mode).toBe('read');
  await expect(requireAccess(request)).rejects.toThrow('NOT_GRANTED');
  expect(queryOne).toHaveBeenCalledTimes(2);
  expect(vi.mocked(queryOne).mock.calls[0][1]).toEqual([1, 'self', 'b-files']);
  expect(vi.mocked(queryOne).mock.calls[0][0]).toContain('g.agent_project_id=p.id AND g.workspace_id=w.id');
});
