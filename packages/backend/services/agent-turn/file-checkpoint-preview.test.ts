import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), audit: vi.fn() }));
vi.mock('./file-checkpoint-repo.js', () => ({ loadCheckpointFileChanges: mocks.load, recordRestoreRun: mocks.audit }));
import { previewCheckpointRestore } from './file-checkpoint-preview.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotFile } from './file-checkpoint.js';

beforeEach(() => vi.clearAllMocks());

describe('checkpoint restore preview service', () => {
  it('audits a ready selected-path preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tower-preview-'));
    try {
      const filePath = join(root, 'a.txt'); await writeFile(filePath, 'before'); const before = await snapshotFile(root, filePath);
      await writeFile(filePath, 'after'); const after = await snapshotFile(root, filePath);
      mocks.load.mockResolvedValue([{ filePath, before, after }]); mocks.audit.mockResolvedValue('run-1');
      const result = await previewCheckpointRestore({ checkpointId: 'c1', projectRoot: root, requestedBy: 7, paths: [filePath] });
      expect(result.canApply).toBe(true);
      expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ status: 'previewed', selectedPaths: [filePath], conflicts: [] }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects requested paths not in checkpoint', async () => {
    mocks.load.mockResolvedValue([]);
    await expect(previewCheckpointRestore({ checkpointId: 'c1', projectRoot: '/tmp', requestedBy: 7, paths: ['/tmp/missing'] })).rejects.toThrow('checkpoint_paths_not_found');
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
