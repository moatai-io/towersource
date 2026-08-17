import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, queryOne, execute } = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query, queryOne, execute }));

import { addChannelSharedFile, listChannelSharedFiles, removeChannelSharedFile } from './channel-shared-files.js';

describe('channel shared files registry', () => {
  beforeEach(() => { query.mockReset(); queryOne.mockReset(); execute.mockReset(); });

  it('lists only active files with uploader metadata', async () => {
    query.mockResolvedValue([{ id: 'f1', channel_id: 'r1', storage_path: '/uploads/f1', original_name: '보고서.pdf', mime_type: 'application/pdf', size_bytes: '100', uploaded_by: 2, uploaded_by_name: 'kim', created_at: new Date('2026-07-13') }]);
    const files = await listChannelSharedFiles('r1');
    expect(files[0]).toMatchObject({ originalName: '보고서.pdf', sizeBytes: 100, uploadedByName: 'kim' });
    expect(query.mock.calls[0][0]).toContain('removed_at IS NULL');
  });

  it('registers a direct channel upload', async () => {
    queryOne.mockResolvedValue({ id: 'f1', channel_id: 'r1', storage_path: '/uploads/f1', original_name: 'a.txt', size_bytes: 3, uploaded_by: 2, created_at: new Date() });
    await expect(addChannelSharedFile({ channelId: 'r1', storagePath: '/uploads/f1', originalName: 'a.txt', sizeBytes: 3, uploadedBy: 2 })).resolves.toMatchObject({ id: 'f1' });
  });

  it('soft-removes the share and returns the physical path', async () => {
    queryOne.mockResolvedValue({ storage_path: '/uploads/f1' });
    await expect(removeChannelSharedFile('r1', 'f1', { userId: 2, canManage: false })).resolves.toBe('/uploads/f1');
    expect(queryOne.mock.calls[0][0]).toContain('uploaded_by = $4');
    expect(queryOne.mock.calls[0][1]).toEqual(['f1', 'r1', false, 2]);
  });

  it('returns null when a non-manager tries to remove another uploader’s file', async () => {
    queryOne.mockResolvedValue(null);
    await expect(removeChannelSharedFile('r1', 'f1', { userId: 3, canManage: false })).resolves.toBeNull();
  });
});
