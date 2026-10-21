/** Real team repository, canonical storage adapter and pure mount planners;
 * only DB reads/legacy compute placement are synthetic. No live mounts or DB.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { query, queryOne } from '../../db/pg-repo.js';
import { readLegacyProjectComputePlacement } from '../project-environment/adapters/legacy-project-compute-adapter.js';
import { resolveTeamWorkspaceMountContext } from './team-mount-context.js';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../project-environment/adapters/legacy-project-compute-adapter.js', () => ({ readLegacyProjectComputePlacement: vi.fn() }));
const request = { userId: 1, agentProjectId: 'a', deploymentId: 'test' };
const inventory = [
  { workspaceId: 'a-files', ownerProjectId: 'a', teamId: 'team-a', registered: true, active: true },
  { workspaceId: 'b-files', ownerProjectId: 'b', teamId: 'team-a', registered: true, active: true },
];
let facts: { user_active: boolean; user_role: string; agent_active: boolean; team_id: string | null; team_member: boolean; workspaces: typeof inventory };
let roots: Array<{ id: string; root_path: string | null }>;
let authorities: Array<{ project_id: string; deployment_id: string; storage_kind: string; worker_id: string | null; state: string; version: number }>;
let afterRead: ((kind: 'team' | 'roots' | 'storage', count: number) => void) | undefined;
let counts: Record<'team' | 'roots' | 'storage', number>;
beforeEach(() => {
  vi.resetAllMocks();
  facts = { user_active: true, user_role: 'member', agent_active: true, team_id: 'team-a', team_member: true, workspaces: structuredClone(inventory) };
  roots = [{ id: 'a', root_path: '/registered/a' }, { id: 'b', root_path: '/registered/b' }, { id: 'outside', root_path: '/registered/outside' }];
  authorities = ['a', 'b'].map(project_id => ({ project_id, deployment_id: 'test', storage_kind: 'host', worker_id: null, state: 'ready', version: 1 }));
  counts = { team: 0, roots: 0, storage: 0 }; afterRead = undefined;
  vi.mocked(queryOne).mockImplementation(async sql => {
    if (!sql.includes('WITH active_agents')) throw new Error('unexpected team query');
    const snapshot = structuredClone(facts);
    counts.team++;
    afterRead?.('team', counts.team);
    return snapshot as any;
  });
  vi.mocked(query).mockImplementation(async (sql, args) => {
    const kind = sql.includes('FROM projects') ? 'roots' : sql.includes('FROM project_file_storage_bindings') ? 'storage' : null;
    if (!kind) throw new Error('unexpected registry query');
    if (kind === 'storage') expect(args).toEqual(['test']);
    const snapshot = structuredClone(kind === 'roots' ? roots : authorities);
    counts[kind]++;
    afterRead?.(kind, counts[kind]);
    return snapshot as any;
  });
});
it('resolves current team inventory through real repositories, preserving own/rw/hashed mounts', async () => {
  const result = await resolveTeamWorkspaceMountContext(request);
  expect(result).toMatchObject({ agentProjectId: 'a', teamId: 'team-a', deploymentId: 'test', mounts: [
    { workspaceId: 'a-files', source: '/registered/a', target: '/workspace', readOnly: false },
    { workspaceId: 'b-files', source: '/registered/b', readOnly: false },
  ] });
  expect(result!.mounts[1].target).toMatch(/^\/connected\/[a-f0-9]{64}$/);
  expect(counts).toEqual({ team: 2, roots: 2, storage: 2 });
  expect(readLegacyProjectComputePlacement).not.toHaveBeenCalled();
  expect(vi.mocked(queryOne).mock.calls.some(([sql]) => /project_members|agent_workspace_grants|INSERT|UPDATE/.test(sql))).toBe(false);
});
it('ignores permission-bearing request extras and mounts only admitted team inventory', async () => {
  const result = await resolveTeamWorkspaceMountContext({ ...request, inventory: [{ workspaceId: 'outside-files', ownerProjectId: 'outside' }], storageLocators: [{ locator: { kind: 'host', root: '/etc' } }] } as typeof request);
  expect(result!.mounts.map(m => m.workspaceId)).toEqual(['a-files', 'b-files']);
});
it('returns null only for confirmed current teamless facts', async () => {
  facts.team_id = null; facts.workspaces = [];
  await expect(resolveTeamWorkspaceMountContext(request)).resolves.toBeNull();
  expect(counts).toEqual({ team: 2, roots: 0, storage: 0 });
});
it.each(['user', 'agent', 'membership', 'viewer'])('fails closed for denied %s, never falling back', async kind => {
  if (kind === 'user') facts.user_active = false;
  if (kind === 'agent') facts.agent_active = false;
  if (kind === 'membership') facts.team_member = false;
  if (kind === 'viewer') facts.user_role = 'viewer';
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
});
it.each(['', ' ', '../test', 'test/deploy'])('rejects invalid deployment %j before DB', async deploymentId => {
  await expect(resolveTeamWorkspaceMountContext({ ...request, deploymentId })).rejects.toThrow('TEAM_WORKSPACE_MOUNT_CONTEXT_REQUIRED');
  expect(queryOne).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});
it('requires the source Agent own workspace in inventory', async () => {
  facts.workspaces = facts.workspaces.slice(1);
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('TEAM_WORKSPACE_OWN_WORKSPACE_REQUIRED');
});
it('rejects missing registered project roots rather than inventing paths', async () => {
  roots = roots.slice(0, 1);
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_MOUNT_SOURCE_UNREGISTERED');
});
it('uses the full original project registry for outside-team nested guards', async () => {
  roots[2].root_path = '/registered/b/private-nested';
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_MOUNT_NESTED_PROJECT');
});
it.each(['/', 'relative', '/registered/b/../b', '/registered/b\n'])('rejects unsafe original registry source %j', async root => {
  roots[1].root_path = root;
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_MOUNT_SOURCE_INVALID');
});
it('rejects explicit remote storage without legacy compute or host fallback', async () => {
  authorities[1] = { ...authorities[1], storage_kind: 'worker', worker_id: 'remote' };
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_REMOTE_MOUNT_UNSUPPORTED');
  expect(readLegacyProjectComputePlacement).not.toHaveBeenCalled();
});
it.each(['pending', 'blocked'])('honors explicit %s canonical authority', async state => {
  authorities[1].state = state;
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_STORAGE_NOT_READY');
  expect(readLegacyProjectComputePlacement).not.toHaveBeenCalled();
});
it('rejects contradictory host authority', async () => {
  authorities[1].worker_id = 'remote';
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_STORAGE_CONFIGURATION_CONFLICT');
});
it('uses real compatibility resolver only for missing canonical bindings; legacy remote is unsupported', async () => {
  authorities = authorities.slice(0, 1);
  vi.mocked(readLegacyProjectComputePlacement).mockResolvedValue({ workstationMode: true, defaultWorkerId: 'remote' } as any);
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_REMOTE_MOUNT_UNSUPPORTED');
  expect(readLegacyProjectComputePlacement).toHaveBeenCalledWith('b', 'test');
});
it('permits confirmed legacy local storage without treating execution Worker settings as canonical', async () => {
  authorities = authorities.slice(0, 1);
  vi.mocked(readLegacyProjectComputePlacement).mockResolvedValue({ workstationMode: false, defaultWorkerId: 'compute-only' } as any);
  expect((await resolveTeamWorkspaceMountContext(request))!.mounts[1].source).toBe('/registered/b');
});
it.each(['team', 'roots', 'storage'] as const)('propagates %s repository errors rather than returning teamless null', async kind => {
  if (kind === 'team') vi.mocked(queryOne).mockRejectedValue(new Error('database unavailable'));
  else afterRead = (readKind, count) => { if (readKind === kind && count === 1) throw new Error('database unavailable'); };
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('database unavailable');
});
it.each(['membership', 'team-move', 'teamless', 'workspace-move', 'owner-change', 'own-change'] as const)('rejects %s around resolution', async change => {
  afterRead = (kind, count) => {
    if (kind !== 'storage' || count !== 1) return;
    if (change === 'membership') facts.team_member = false;
    if (change === 'team-move') facts.team_id = 'team-other';
    if (change === 'teamless') facts.team_id = null;
    if (change === 'workspace-move') facts.workspaces.pop();
    if (change === 'owner-change') facts.workspaces[1].ownerProjectId = 'outside';
    if (change === 'own-change') facts.workspaces[0].workspaceId = 'a-replacement';
  };
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow(/TEAM_WORKSPACE_(ACCESS_DENIED|CONTEXT_CHANGED)/);
});
it('rejects team assignment appearing while confirming teamless', async () => {
  facts.team_id = null; facts.workspaces = [];
  afterRead = (kind, count) => { if (kind === 'team' && count === 1) facts.team_id = 'team-a'; };
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_CHANGED');
});
it.each(['root', 'storage', 'version'] as const)('rejects %s authority changing around resolution', async change => {
  afterRead = (kind, count) => {
    if (kind !== 'storage' || count !== 1) return;
    if (change === 'root') roots[1].root_path = '/registered/moved';
    if (change === 'storage') authorities[1] = { ...authorities[1], storage_kind: 'worker', worker_id: 'remote' };
    if (change === 'version') authorities[1].version++;
  };
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow(/WORKSPACE_(STORAGE_CHANGED|REMOTE_MOUNT_UNSUPPORTED)/);
});
it('rejects a new outside-team nested project on recheck', async () => {
  afterRead = (kind, count) => { if (kind === 'storage' && count === 1) roots.push({ id: 'new-nested', root_path: '/registered/b/nested' }); };
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_MOUNT_NESTED_PROJECT');
});
it('rejects duplicate canonical storage records rather than selecting the first', async () => {
  authorities.push({ ...authorities[1], storage_kind: 'worker', worker_id: 'remote' });
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_STORAGE_CONFIGURATION_CONFLICT');
});
it('permits outside-team projects without registered storage, but never mounts a missing own root', async () => {
  roots[2].root_path = null;
  expect((await resolveTeamWorkspaceMountContext(request))!.mounts).toHaveLength(2);
  roots[0].root_path = null;
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('WORKSPACE_MOUNT_SOURCE_UNREGISTERED');
});
it('accepts inventory order changes without losing the own source reference', async () => {
  afterRead = (kind, count) => { if (kind === 'storage' && count === 1) facts.workspaces.reverse(); };
  expect((await resolveTeamWorkspaceMountContext(request))!.mounts[0].target).toBe('/workspace');
});
it('does not admit stale or unrelated workspace facts injected into the repository row', async () => {
  facts.workspaces.push({ workspaceId: 'outside-files', ownerProjectId: 'outside', teamId: 'other-team', active: true, registered: true });
  expect((await resolveTeamWorkspaceMountContext(request))!.mounts.map(m => m.workspaceId)).toEqual(['a-files', 'b-files']);
});
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('validates server user identifier %j with the real repository', async userId => {
  await expect(resolveTeamWorkspaceMountContext({ ...request, userId })).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  expect(queryOne).not.toHaveBeenCalled();
});
it('handles the documented missing canonical table through the real compatibility boundary', async () => {
  const original = vi.mocked(query).getMockImplementation()!;
  vi.mocked(query).mockImplementation(async (sql, args) => {
    if (sql.includes('FROM project_file_storage_bindings')) {
      throw Object.assign(new Error('relation "project_file_storage_bindings" does not exist'), { code: '42P01' });
    }
    return original(sql, args) as any;
  });
  expect((await resolveTeamWorkspaceMountContext(request))!.mounts).toHaveLength(2);
  expect(readLegacyProjectComputePlacement).toHaveBeenCalledTimes(4);
});
it('does not treat arbitrary storage permission/table errors as canonical host compatibility', async () => {
  const original = vi.mocked(query).getMockImplementation()!;
  vi.mocked(query).mockImplementation(async (sql, args) => {
    if (sql.includes('FROM project_file_storage_bindings')) {
      throw Object.assign(new Error('permission denied for project_file_storage_bindings'), { code: '42501' });
    }
    return original(sql, args) as any;
  });
  await expect(resolveTeamWorkspaceMountContext(request)).rejects.toThrow('permission denied');
  expect(readLegacyProjectComputePlacement).not.toHaveBeenCalled();
});
