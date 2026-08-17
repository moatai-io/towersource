import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryOne, query, execute, configMock } = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  configMock: { dataDir: '' },
}));
vi.mock('../../db/pg-repo.js', () => ({ queryOne, query, execute }));
vi.mock('../../config.js', () => ({ config: configMock }));
vi.mock('../pm/project-manager.js', () => ({ getProject: vi.fn() }));
vi.mock('../pm/project-access.js', () => ({ isPathWritableByRole: vi.fn() }));
vi.mock('../personal-space/personal-space-store.js', () => ({ createPersonalBinaryFile: vi.fn() }));

import { createSessionAttachment, createSessionAttachmentFromPath, purgeExpiredSessionAttachments, resolveReadableSessionAttachment, resolveSessionAttachment, sessionAttachmentIdFromUri } from './session-attachment-store.js';

let root = '';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-session-attachment-test-'));
  configMock.dataDir = root;
  queryOne.mockReset(); query.mockReset(); execute.mockReset();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('session attachment store', () => {
  it('stores bytes outside the project and returns a virtual URI', async () => {
    queryOne.mockImplementation(async (_sql: string, params: any[]) => ({
      id: params[0], owner_user_id: params[1], session_id: params[2], project_id: params[3], original_name: params[4], storage_path: params[5], mime_type: params[6], size_bytes: params[7], status: 'temporary', promoted_uri: null, expires_at: new Date(Date.now() + 10000).toISOString(), created_at: new Date().toISOString(),
    }));
    const doc = await createSessionAttachment({ userId: 7, sessionId: 's1', name: '자료.pdf', mimeType: 'application/pdf', content: Buffer.from('pdf') });
    expect(doc.uri).toMatch(/^session:\/\/attachments\//);
    const insertedPath = queryOne.mock.calls[0][1][5];
    expect(insertedPath).toContain(path.join('session-attachments', '7', 's1'));
    expect(insertedPath).not.toContain(path.join('projects'));
  });

  it('streams a staged file into session storage without a route Buffer', async () => {
    queryOne.mockImplementation(async (_sql: string, params: any[]) => ({
      id: params[0], owner_user_id: params[1], session_id: params[2], project_id: params[3], original_name: params[4], storage_path: params[5], mime_type: params[6], size_bytes: params[7], status: 'temporary', promoted_uri: null, expires_at: new Date(Date.now() + 10000).toISOString(), created_at: new Date().toISOString(),
    }));
    const staged = path.join(root, 'staged.upload');
    await fs.writeFile(staged, 'streamed bytes');
    const doc = await createSessionAttachmentFromPath({ userId: 7, sessionId: 's1', name: '자료.txt', mimeType: 'text/plain', sourcePath: staged });
    expect(doc.sizeBytes).toBe(Buffer.byteLength('streamed bytes'));
    const stored = queryOne.mock.calls[0][1][5];
    await expect(fs.readFile(stored, 'utf8')).resolves.toBe('streamed bytes');
  });

  it('rejects malformed session URIs', () => {
    expect(() => sessionAttachmentIdFromUri('personal://x')).toThrow('Invalid session attachment URI');
  });

  it('requires the same owner and session when resolving', async () => {
    queryOne.mockResolvedValue(undefined);
    await expect(resolveSessionAttachment(7, 'other-session', '11111111-1111-4111-8111-111111111111')).rejects.toThrow('not found');
    expect(queryOne.mock.calls[0][1]).toEqual(['11111111-1111-4111-8111-111111111111', 7, 'other-session']);
  });

  it('resolves readable bytes by session after the route has checked session access', async () => {
    const storagePath = path.join(root, 'session-attachments', '7', 's1', '11111111-1111-4111-8111-111111111111', 'team.png');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, 'png');
    queryOne.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', owner_user_id: 7, session_id: 's1', project_id: 'p1',
      original_name: 'team.png', storage_path: storagePath, mime_type: 'image/png', size_bytes: 3,
      status: 'temporary', promoted_uri: null, expires_at: new Date(Date.now() + 10000).toISOString(), created_at: new Date().toISOString(),
    });

    const resolved = await resolveReadableSessionAttachment('s1', '11111111-1111-4111-8111-111111111111');
    expect(resolved.document.name).toBe('team.png');
    expect(queryOne.mock.calls[0][1]).toEqual(['11111111-1111-4111-8111-111111111111', 's1']);
  });

  it('expires promoted source snapshots as well as temporary ones', async () => {
    const storagePath = path.join(root, 'session-attachments', '7', 's1', '11111111-1111-4111-8111-111111111111', 'saved.pdf');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, 'pdf');
    query.mockResolvedValue([{
      id: '11111111-1111-4111-8111-111111111111', owner_user_id: 7, session_id: 's1', project_id: null,
      original_name: 'saved.pdf', storage_path: storagePath, mime_type: 'application/pdf', size_bytes: 3,
      status: 'promoted_personal', promoted_uri: 'personal://files/saved.pdf', expires_at: new Date(0).toISOString(), created_at: new Date(0).toISOString(),
    }]);

    await expect(purgeExpiredSessionAttachments()).resolves.toBe(1);
    expect(query.mock.calls[0][0]).toContain('ORDER BY session_attachments.expires_at ASC');
    await expect(fs.stat(storagePath)).rejects.toThrow();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status = 'deleted'"), [['11111111-1111-4111-8111-111111111111']]);
  });
});
