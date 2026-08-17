import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadWorkerProjectFile, readWorkerProjectManifest, type WorkerFileAuthority } from './workbench-project-file-authority.js';
import { reconcileWorkerProjectDerivedMirror } from './workbench-project-derived-reconcile.js';

vi.mock('./workbench-project-file-authority.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./workbench-project-file-authority.js')>();
  return { ...actual, readWorkerProjectManifest: vi.fn(), downloadWorkerProjectFile: vi.fn() };
});

const roots: string[] = [];
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function setup(): { root: string; authority: WorkerFileAuthority } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-derived-reconcile-'));
  roots.push(root);
  return {
    root,
    authority: { projectId: 'p1', projectRoot: root, relativePath: 'work/scope', workerId: 'w1', workerBaseUrl: 'http://worker' },
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Worker derived mirror reconcile', () => {
  it('downloads changed files, keeps matching files, and removes stale host entries', async () => {
    const { root, authority } = setup();
    const subtree = path.join(root, 'work', 'scope');
    fs.mkdirSync(path.join(subtree, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(subtree, 'same.md'), 'same');
    fs.writeFileSync(path.join(subtree, 'changed.md'), 'old');
    fs.writeFileSync(path.join(subtree, 'stale.md'), 'stale');
    const changed = Buffer.from('new');
    vi.mocked(readWorkerProjectManifest).mockResolvedValue({
      fileCount: 2,
      totalBytes: 7,
      entries: [
        { path: 'work/scope/docs', type: 'directory', modified: new Date(0).toISOString() },
        { path: 'work/scope/same.md', type: 'file', sizeBytes: 4, modified: new Date(0).toISOString(), sha256: hash('same') },
        { path: 'work/scope/changed.md', type: 'file', sizeBytes: 3, modified: new Date(0).toISOString(), sha256: hash(changed) },
      ],
    });
    vi.mocked(downloadWorkerProjectFile).mockResolvedValue(changed);

    const result = await reconcileWorkerProjectDerivedMirror({ authority, actorUserId: 1 });

    expect(result).toMatchObject({ downloaded: 1, unchanged: 1, deleted: 1, workerFiles: 2 });
    expect(fs.readFileSync(path.join(subtree, 'changed.md'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(subtree, 'stale.md'))).toBe(false);
    expect(downloadWorkerProjectFile).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({ relativePath: 'work/scope/changed.md' }),
    }));
  });

  it('does not delete host files when the Worker manifest fails before reconciliation', async () => {
    const { root, authority } = setup();
    const hostFile = path.join(root, 'work', 'scope', 'host.md');
    fs.mkdirSync(path.dirname(hostFile), { recursive: true });
    fs.writeFileSync(hostFile, 'keep');
    vi.mocked(readWorkerProjectManifest).mockRejectedValue(new Error('manifest file limit exceeded'));

    await expect(reconcileWorkerProjectDerivedMirror({ authority, actorUserId: 1 })).rejects.toThrow('manifest file limit exceeded');
    expect(fs.readFileSync(hostFile, 'utf8')).toBe('keep');
  });
});
