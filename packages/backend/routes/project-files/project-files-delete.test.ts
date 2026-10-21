import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ writable: vi.fn(), accessible: vi.fn(), findProject: vi.fn(), getProject: vi.fn(), deleteProjectEntry: vi.fn(), remove: vi.fn() }));
vi.mock('../../config.js', () => ({ config: { workspaceRoot: '/workspace' } }));
vi.mock('../../services/inline-edit/index.js', () => ({}));
vi.mock('../../services/auth/auth.js', () => ({ getUserAllowedPath: vi.fn(async () => '/workspace') }));
vi.mock('../../services/workspace/file-system.js', () => ({ deleteEntry: m.remove, invalidateTreeCache: vi.fn() }));
vi.mock('../../services/workspace/notes-index.js', () => ({}));
vi.mock('../../services/workspace/knowledge-graph.js', () => ({}));
vi.mock('../../services/workspace/share-manager.js', () => ({}));
vi.mock('../../services/pm/project-access.js', () => ({ findProjectByPath: m.findProject, isPathAccessible: m.accessible, isPathWritableByRole: m.writable, isPrivilegedRole: vi.fn(), isDotfileDenied: vi.fn() }));
vi.mock('../../services/pm/project-manager.js', () => ({ getProject: m.getProject }));
vi.mock('../../services/project-environment/project-workspace-files.js', () => ({ resolveProjectWorkspaceFile: vi.fn(async (input: any) => input), deleteProjectWorkspaceEntry: m.deleteProjectEntry }));
vi.mock('./project-files-access.js', () => ({ isPathAllowedByCoarseRootOrAcl: vi.fn(async () => true) }));
vi.mock('../../services/runtime-box/workbench-project-file-authority.js', () => ({ assertProjectSharedMutationForHostPath: vi.fn() }));
import router from './project-files-router.js';
async function invoke(role: string, userId: number | undefined = 7) {
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/files/delete');
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await layer.route.stack[0].handle({ body: { path: '/workspace/projects/demo/file.txt' }, user: { role, userId } }, res);
  return res;
}
beforeEach(() => { vi.resetAllMocks(); m.accessible.mockResolvedValue(true); m.writable.mockResolvedValue(true); m.findProject.mockResolvedValue(undefined); });
describe('file delete uses write authority before storage mutation', () => {
  it.each(['guest', 'viewer'])('denies %s before resolving storage', async role => {
    const res = await invoke(role); expect(res.status).toHaveBeenCalledWith(403); expect(m.findProject).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled();
  });
  it('denies a member with read-only project membership', async () => {
    m.writable.mockResolvedValue(false); const res = await invoke('member');
    expect(res.status).toHaveBeenCalledWith(403); expect(m.findProject).not.toHaveBeenCalled();
  });
  it.each(['member', 'operator', 'admin'])('allows %s with write authority', async role => {
    await invoke(role); expect(m.writable).toHaveBeenCalledWith('/workspace/projects/demo/file.txt', 7, role); expect(m.remove).toHaveBeenCalledOnce();
  });
  it('checks write authority before Project storage deletion and does not fall back to host on failure', async () => {
    m.findProject.mockResolvedValue('p'); m.getProject.mockResolvedValue({ rootPath: '/workspace/projects/demo' }); m.deleteProjectEntry.mockRejectedValue(new Error('offline'));
    const res = await invoke('member'); expect(res.status).toHaveBeenCalledWith(500); expect(m.deleteProjectEntry).toHaveBeenCalledOnce(); expect(m.remove).not.toHaveBeenCalled();
  });
});
