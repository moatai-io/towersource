import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => mocks);

import { ensureTurnCheckpoint, loadCheckpointFileChanges, recordCheckpointFileChange, recordRestoreRun } from './file-checkpoint-repo.js';

beforeEach(() => vi.clearAllMocks());

describe('file checkpoint repository', () => {
  it('upserts one root-turn checkpoint and preserves partial coverage', async () => {
    mocks.queryOne.mockResolvedValue({ id: 'checkpoint-1' });
    await expect(ensureTurnCheckpoint({ rootTurnId: 'turn-1', sessionId: 'session-1', partial: true })).resolves.toBe('checkpoint-1');
    expect(mocks.queryOne.mock.calls[0][0]).toContain("turn_checkpoints.coverage = 'partial'");
    expect(mocks.queryOne.mock.calls[0][1]).toEqual(['turn-1', 'session-1', 'partial']);
  });

  it('keeps first before and updates only after columns on repeated paths', async () => {
    const before = { exists: true, sha256: 'before', content: Buffer.from('before') };
    const after = { exists: true, sha256: 'after', content: Buffer.from('after') };
    await recordCheckpointFileChange({ checkpointId: 'c1', filePath: '/p/a', toolName: 'edit', before, after });
    const sql = mocks.execute.mock.calls[0][0] as string;
    expect(sql).toContain('ON CONFLICT (checkpoint_id, file_path) DO UPDATE');
    expect(sql).toContain('after_sha256 = EXCLUDED.after_sha256');
    expect(sql).not.toContain('before_sha256 = EXCLUDED.before_sha256');
  });

  it('loads stored before and after blobs', async () => {
    mocks.query.mockResolvedValue([{ file_path: '/p/a', before_exists: true, before_sha256: 'b', before_content: Buffer.from('b'), after_exists: false, after_sha256: null, after_content: null }]);
    const result = await loadCheckpointFileChanges('c1');
    expect(result[0]).toMatchObject({ filePath: '/p/a', before: { exists: true, sha256: 'b' }, after: { exists: false } });
  });

  it('writes append-only restore audit rows', async () => {
    mocks.queryOne.mockResolvedValue({ id: 'run-1' });
    await expect(recordRestoreRun({ checkpointId: 'c1', requestedBy: 7, status: 'conflict', previewHash: 'h', selectedPaths: ['/p/a'], conflicts: [{ path: '/p/a' }] })).resolves.toBe('run-1');
    expect(mocks.queryOne.mock.calls[0][0]).toContain('INSERT INTO checkpoint_restore_runs');
    expect(mocks.queryOne.mock.calls[0][1][4]).toBe('["/p/a"]');
  });
});
