import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ writable: vi.fn(), accessible: vi.fn(), findProject: vi.fn(), getProject: vi.fn(), writeProject: vi.fn(), writeLocal: vi.fn(),createLocal:vi.fn() }));
vi.mock('../../config.js', () => ({ config: { workspaceRoot: '/workspace' } }));
vi.mock('../../services/inline-edit/index.js', () => ({}));
vi.mock('../../services/auth/auth.js', () => ({ getUserAllowedPath: vi.fn(async () => '/workspace') }));
vi.mock('../../services/workspace/file-system.js', () => ({ writeFileContent: m.writeLocal, createFile:m.createLocal,invalidateTreeCache: vi.fn() }));
vi.mock('../../services/workspace/notes-index.js', () => ({}));
vi.mock('../../services/workspace/knowledge-graph.js', () => ({}));
vi.mock('../../services/workspace/share-manager.js', () => ({}));
vi.mock('../../services/pm/project-access.js', () => ({ findProjectByPath: m.findProject, isPathAccessible: m.accessible, isPathWritableByRole: m.writable, isPrivilegedRole: vi.fn(), isDotfileDenied: vi.fn() }));
vi.mock('../../services/pm/project-manager.js', () => ({ getProject: m.getProject }));
vi.mock('../../services/project-environment/project-workspace-files.js', () => ({ resolveProjectWorkspaceFile: vi.fn(async (input: any) => input), writeProjectWorkspaceText: m.writeProject }));
vi.mock('./project-files-access.js', () => ({ isPathAllowedByCoarseRootOrAcl: vi.fn(async () => true) }));
vi.mock('../../services/runtime-box/workbench-project-file-authority.js', () => ({ assertProjectSharedMutationForHostPath: vi.fn() }));
import router from './project-files-router.js';

async function invoke(endpoint:string) {
 const layer=(router as any).stack.find((l:any)=>l.route?.path===endpoint);
 const res:any={status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis()};
 await layer.route.stack[0].handle({body:{path:'/workspace/projects/demo/a.txt',content:'new'},user:{role:'member',userId:7}},res); return res;
}
beforeEach(()=>{vi.clearAllMocks();m.accessible.mockResolvedValue(true);m.writable.mockResolvedValue(true);m.findProject.mockResolvedValue('p');m.getProject.mockResolvedValue({rootPath:'/workspace/projects/demo'});});
describe('canonical write failure is explicit and never falls back',()=>{
 it.each(['/files/write','/files/create'])('%s reports temporary unavailability',async endpoint=>{
  m.writeProject.mockRejectedValue(new Error('CANONICAL_WRITE_UNAVAILABLE')); const res=await invoke(endpoint);
  expect(res.status).toHaveBeenCalledWith(503);expect(res.json).toHaveBeenCalledWith(expect.objectContaining({code:'CANONICAL_WRITE_UNAVAILABLE',retryable:false}));expect(m.writeLocal).not.toHaveBeenCalled();expect(m.createLocal).not.toHaveBeenCalled();
 });
 it.each(['/files/write','/files/create'])('%s reports unknown outcome without automatic retry',async endpoint=>{
  m.writeProject.mockRejectedValue(new Error('CANONICAL_WRITE_NOT_CONFIRMED'));const res=await invoke(endpoint);
  expect(res.status).toHaveBeenCalledWith(409);expect(res.json).toHaveBeenCalledWith(expect.objectContaining({code:'CANONICAL_WRITE_NOT_CONFIRMED',retryable:false}));expect(m.writeProject).toHaveBeenCalledTimes(1);
 });
 it('does not disclose unknown provider diagnostics',async()=>{
  m.writeProject.mockRejectedValue(new Error('CANONICAL_WRITE_INTERNAL private-info'));const res=await invoke('/files/write');
  expect(res.status).toHaveBeenCalledWith(503);expect(JSON.stringify(res.json.mock.calls)).not.toContain('private-info');
 });
});
