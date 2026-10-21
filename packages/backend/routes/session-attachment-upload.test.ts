import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ create: vi.fn(), access: vi.fn(), query: vi.fn(), writable: vi.fn(), rm: vi.fn() }));
vi.mock('../config.js', () => ({ config: { dataDir: '/data' } }));
vi.mock('../db/pg-repo.js', () => ({ queryOne: m.query }));
vi.mock('../services/pm/project-access.js', () => ({ canWriteSessionContent: m.access, canAccessSession: vi.fn(), isPathWritableByRole: m.writable }));
vi.mock('node:fs/promises', () => ({ default: { rm: m.rm } }));
vi.mock('../services/session-attachments/session-attachment-store.js', () => ({
 SessionAttachmentError: class extends Error { constructor(public code: string, message: string) { super(message); } },
 createSessionAttachmentFromPath: m.create, deleteSessionAttachment: vi.fn(), listSessionAttachments: vi.fn(), promoteSessionAttachmentToPersonal: vi.fn(), promoteSessionAttachmentToProject: vi.fn(), resolveReadableSessionAttachment: vi.fn(), resolveSessionAttachment: vi.fn(),
}));
import router from './session-attachment-api.js';
const route = router.stack.find((layer: any) => layer.route?.path === '/:sessionId' && layer.route.methods.post)!.route!;
const handler = route.stack[route.stack.length - 1].handle;
async function upload(role = 'operator') {
 const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
 await handler({ user: { userId: 7, role }, params: { sessionId: 's1' }, files: [{ path: '/data/staged', originalname: 'image.png', mimetype: 'image/png', size: 3 }] } as any, res, vi.fn());
 return res;
}
beforeEach(() => { vi.resetAllMocks(); m.rm.mockResolvedValue(undefined); m.access.mockResolvedValue({ allowed: true }); m.query.mockResolvedValue({ project_id: 'protected-project' }); m.writable.mockResolvedValue(false); m.create.mockResolvedValue({ uri: 'session://attachments/id', status: 'temporary' }); });
describe('session upload authorization', () => {
 it('lets a session writer attach PNG without protected project write privileges', async () => {
  const res = await upload(); expect(res.status).toHaveBeenCalledWith(200);
  expect(m.create).toHaveBeenCalledWith({ userId: 7, sessionId: 's1', projectId: 'protected-project', name: 'image.png', mimeType: 'image/png', sourcePath: '/data/staged' });
  expect(m.writable).not.toHaveBeenCalled(); expect(m.rm).toHaveBeenCalled();
 });
 it('also supports sessions without a project', async () => { m.query.mockResolvedValue({ project_id: null }); expect((await upload()).status).toHaveBeenCalledWith(200); });
 it.each(['viewer', 'guest'])('rejects %s before storing bytes', async role => { expect((await upload(role)).status).toHaveBeenCalledWith(403); expect(m.create).not.toHaveBeenCalled(); });
 it('rejects another session without write access', async () => { m.access.mockResolvedValue({ allowed: false, status: 403, message: 'Denied' }); expect((await upload()).status).toHaveBeenCalledWith(403); expect(m.create).not.toHaveBeenCalled(); });
 it.each([['ENAMETOOLONG', 'Filename is too long'], ['ENOSPC', 'Storage is full'], ['EACCES', 'Storage access denied']])('classifies %s without leaking host paths', async (code, message) => {
  m.create.mockRejectedValue(Object.assign(new Error('/private/storage failed'), { code }));
  const res = await upload();
  expect(res.status).toHaveBeenCalledWith(207);
  expect(JSON.stringify(res.json.mock.calls)).toContain(message);
  expect(JSON.stringify(res.json.mock.calls)).not.toContain('/private/storage');
  expect(m.rm).toHaveBeenCalled();
 });
 it('returns bounded failure details and cleans staging when persistence fails', async () => { m.create.mockRejectedValue(new Error('/private/path disk failed')); const res = await upload(); expect(res.status).toHaveBeenCalledWith(207); expect(JSON.stringify(res.json.mock.calls)).not.toContain('/private/path'); expect(m.rm).toHaveBeenCalled(); });
});
