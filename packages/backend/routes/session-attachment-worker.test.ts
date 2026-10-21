import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ project: vi.fn(), writable: vi.fn(), commit: vi.fn() }));
vi.mock('../config.js', () => ({ config: { dataDir: '/data' } }));
vi.mock('../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
vi.mock('../services/session-attachments/session-attachment-store.js', () => ({ SessionAttachmentError: class extends Error {}, deleteSessionAttachment: vi.fn(), listSessionAttachments: vi.fn(), promoteSessionAttachmentToPersonal: vi.fn(), promoteSessionAttachmentToProject: vi.fn(), resolveReadableSessionAttachment: vi.fn(), resolveSessionAttachment: vi.fn() }));
vi.mock('../services/pm/project-manager.js', () => ({ getProject: mocks.project }));
vi.mock('../services/pm/project-access.js', () => ({ isPathWritableByRole: mocks.writable, canAccessSession: vi.fn(), canWriteSessionContent: vi.fn() }));
vi.mock('../services/project-environment/project-workspace-files.js', () => ({ commitProjectWorkspaceFile: mocks.commit }));
import { commitStagedProjectUpload } from '../services/session-attachments/project-attachment-upload.js';
const input = { sourcePath: '/data/staged', originalName: 'capture.png', sizeBytes: 3, projectId: 'p', userId: 7, userRole: 'member' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.project.mockResolvedValue({ rootPath: '/projects/p' });
  mocks.writable.mockResolvedValue(true);
  mocks.commit.mockResolvedValue({ relativePath: 'uploads/capture.png', name: 'capture.png', compensate: vi.fn() });
});
describe('chat upload workspace authority', () => {
 it('commits through the Project workspace façade', async () => {
  const result = await commitStagedProjectUpload(input);
  expect(mocks.commit).toHaveBeenCalledWith({ projectId: 'p', relativeDirectory: 'uploads', requestedName: 'capture.png', sourcePath: '/data/staged', sizeBytes: 3, actorUserId: 7 });
  expect(result).toMatchObject({ status: 'project_file', uri: '/projects/p/uploads/capture.png', promotedUri: '/projects/p/uploads/capture.png', name: 'capture.png' });
 });
 it('does not bypass a façade failure', async () => {
  mocks.commit.mockRejectedValue(new Error('WORKER_FILE_AUTHORITY_UNAVAILABLE'));
  await expect(commitStagedProjectUpload(input)).rejects.toThrow('UNAVAILABLE');
 });
 it('checks ACL before committing to workspace storage', async () => {
  mocks.writable.mockResolvedValue(false);
  await expect(commitStagedProjectUpload(input)).rejects.toThrow();
  expect(mocks.commit).not.toHaveBeenCalled();
 });
 it('returns the collision-safe name selected by the façade', async () => {
  mocks.commit.mockResolvedValue({ relativePath: 'uploads/capture (1).png', name: 'capture (1).png', compensate: vi.fn() });
  const result = await commitStagedProjectUpload(input);
  expect(result.name).toBe('capture (1).png');
  expect(result.uri).toBe('/projects/p/uploads/capture (1).png');
 });
});
