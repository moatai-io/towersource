import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
const m = vi.hoisted(() => ({ resolve: vi.fn(), download: vi.fn(), access: vi.fn(), auth: vi.fn(), prepare: vi.fn(), vision: vi.fn() }));
vi.mock('../services/pm/project-access.js', () => ({ isPathAccessible: m.access }));
vi.mock('../services/auth/auth.js', () => ({ getUserAuthState: m.auth }));
vi.mock('../services/runtime-box/workbench-project-file-authority.js', () => ({ resolveWorkerFileAuthorityForHostPath: m.resolve, downloadWorkerProjectFile: m.download }));
vi.mock('../services/content-safety/file-representation-gateway.js', () => ({ prepareFileRepresentation: m.prepare, readPreparedVisionImage: m.vision }));
import { readWorkerImage } from './pi-worker-image-read.js';
const ctx = { cwd: '/synthetic/project', projectId: 'p', userId: 7 };
beforeEach(() => {
 vi.resetAllMocks();
 m.resolve.mockResolvedValue({ projectId: 'p', relativePath: 'uploads/capture.png' });
 m.auth.mockResolvedValue({ role: 'admin', disabled: false, approvalStatus: 'active' });
 m.access.mockResolvedValue(true); m.download.mockResolvedValue(Buffer.from('synthetic-image'));
 m.prepare.mockImplementation(async (path: string) => ({ path }));
 m.vision.mockResolvedValue({ type: 'image', data: 'synthetic', mimeType: 'image/png' });
});
describe('Worker-owned upload read without a readable host mirror', () => {
 it('reads Worker bytes, uses the vision gateway and deletes its private temporary copy', async () => {
  const result = await readWorkerImage('uploads/capture.png', ctx);
  expect(result?.content[0].type).toBe('image');
  expect(m.download).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7, maxBytes: 20 * 1024 * 1024 }));
  await expect(fs.stat(m.prepare.mock.calls[0][0])).rejects.toMatchObject({ code: 'ENOENT' });
 });
 it('denies revoked access before downloading', async () => {
  m.access.mockResolvedValue(false);
  await expect(readWorkerImage('uploads/capture.png', ctx)).rejects.toThrow('ACCESS_DENIED');
  expect(m.download).not.toHaveBeenCalled();
 });
 it('rejects another Project binding before downloading', async () => {
  m.resolve.mockResolvedValue({ projectId: 'other' });
  await expect(readWorkerImage('uploads/capture.png', ctx)).rejects.toThrow('PROJECT_MISMATCH');
  expect(m.download).not.toHaveBeenCalled();
 });
 it('does not fall back to the host after Worker failure', async () => {
  m.download.mockRejectedValue(new Error('Worker unavailable'));
  await expect(readWorkerImage('uploads/capture.png', ctx)).rejects.toThrow('Worker unavailable');
  expect(m.prepare).not.toHaveBeenCalled();
 });
 it('cleans up even if image decoding fails', async () => {
  m.vision.mockRejectedValue(new Error('invalid image'));
  await expect(readWorkerImage('uploads/capture.png', ctx)).rejects.toThrow('invalid image');
  await expect(fs.stat(m.prepare.mock.calls[0][0])).rejects.toMatchObject({ code: 'ENOENT' });
 });
 it('preserves ordinary local reads and non-image paths', async () => {
  expect(await readWorkerImage('notes.md', ctx)).toBeNull();
  m.resolve.mockResolvedValue(undefined);
  expect(await readWorkerImage('local.png', ctx)).toBeNull();
  expect(m.download).not.toHaveBeenCalled();
 });
});
