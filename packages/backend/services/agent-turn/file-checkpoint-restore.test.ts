import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), audit: vi.fn() }));
vi.mock('./file-checkpoint-repo.js', () => ({ loadCheckpointFileChanges: mocks.load, recordRestoreRun: mocks.audit }));
import { applyConfirmedCheckpointRestore } from './file-checkpoint-restore.js';

beforeEach(() => vi.clearAllMocks());

describe('confirmed checkpoint restore', () => {
  it('requires explicit confirmation before loading files', async () => {
    await expect(applyConfirmedCheckpointRestore({ checkpointId: 'c1', projectRoot: '/tmp', requestedBy: 7, previewHash: 'h', confirmed: false })).rejects.toThrow('checkpoint_restore_confirmation_required');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('rejects selected paths absent from checkpoint', async () => {
    mocks.load.mockResolvedValue([]);
    await expect(applyConfirmedCheckpointRestore({ checkpointId: 'c1', projectRoot: '/tmp', requestedBy: 7, paths: ['/tmp/a'], previewHash: 'h', confirmed: true })).rejects.toThrow('checkpoint_paths_not_found');
  });
});
