import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./workbench-project-file-authority.js', () => ({ downloadWorkerProjectFile: vi.fn(), writeWorkerProjectFile: vi.fn(), createWorkerProjectDirectory: vi.fn(), compareAndSwapWorkerProjectFile: vi.fn() }));
import { downloadWorkerProjectFile, writeWorkerProjectFile, createWorkerProjectDirectory, compareAndSwapWorkerProjectFile } from './workbench-project-file-authority.js';
import { createWorkerFileToolOperations } from './workbench-file-tool-operations.js';
const authority = { projectId: 'p', projectRoot: '/projects/p', relativePath: '.', workerId: 'w', workerBaseUrl: 'http://worker.test' };
beforeEach(() => vi.resetAllMocks());
it('pins file writes to the same Worker and avoids mkdir of the Project root', async () => {
 const op = createWorkerFileToolOperations(authority, 7);
 await op.write.mkdir('/projects/p');
 expect(createWorkerProjectDirectory).not.toHaveBeenCalled();
 await op.write.writeFile('/projects/p/a.txt', 'hello');
 expect(writeWorkerProjectFile).toHaveBeenCalledWith({ authority: { ...authority, relativePath: 'a.txt' }, actorUserId: 7, content: 'hello' });
});
it('rejects escaping paths without dispatch', async () => {
 await expect(createWorkerFileToolOperations(authority, 7).write.writeFile('/projects/other/a', 'x')).rejects.toThrow('OUTSIDE_PROJECT');
 expect(writeWorkerProjectFile).not.toHaveBeenCalled();
});
it('uses the exact read snapshot for CAS and consumes it once', async () => {
 vi.mocked(downloadWorkerProjectFile).mockResolvedValue(Buffer.from('original'));
 const op = createWorkerFileToolOperations(authority, 7);
 await op.edit.readFile('/projects/p/a');
 await op.edit.writeFile('/projects/p/a', 'changed');
 expect(compareAndSwapWorkerProjectFile).toHaveBeenCalledWith(expect.objectContaining({ expectedContent: 'original', content: 'changed' }));
 await expect(op.edit.writeFile('/projects/p/a', 'again')).rejects.toThrow('SNAPSHOT_REQUIRED');
});
it('propagates Worker failure instead of falling back to local storage', async () => {
 vi.mocked(writeWorkerProjectFile).mockRejectedValue(new Error('WORKER_OFFLINE'));
 await expect(createWorkerFileToolOperations(authority, 7).write.writeFile('/projects/p/a', 'x')).rejects.toThrow('WORKER_OFFLINE');
});
it('rejects lossy UTF8 reads before allowing an edit', async () => {
 vi.mocked(downloadWorkerProjectFile).mockResolvedValue(Buffer.from([255]));
 const op = createWorkerFileToolOperations(authority, 7);
 await expect(op.edit.readFile('/projects/p/a')).rejects.toThrow('REQUIRES_UTF8');
 await expect(op.edit.writeFile('/projects/p/a', 'x')).rejects.toThrow('SNAPSHOT_REQUIRED');
});
