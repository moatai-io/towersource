import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mirrorWorkerProjectMutation } from './workbench-project-derived-mirror.js';
import type { WorkerFileAuthority } from './workbench-project-file-authority.js';

const roots: string[] = [];

function setup(): { root: string; authority: WorkerFileAuthority } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-derived-mirror-'));
  roots.push(root);
  return {
    root,
    authority: {
      projectId: 'project-1',
      projectRoot: root,
      relativePath: '.',
      workerId: 'worker-1',
      workerBaseUrl: 'http://worker.invalid',
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Worker Project derived mirror', () => {
  it('mirrors text, upload, directory, rename, copy, and delete mutations', () => {
    const { root, authority } = setup();
    const source = path.join(root, '..', `upload-${Date.now()}.bin`);
    fs.writeFileSync(source, Buffer.from([0, 1, 2, 255]));
    try {
      const text = path.join(root, 'notes', 'a.md');
      mirrorWorkerProjectMutation(authority, { kind: 'write-text', hostPath: text, content: '# A' });
      expect(fs.readFileSync(text, 'utf8')).toBe('# A');

      const upload = path.join(root, 'sources', 'a.bin');
      mirrorWorkerProjectMutation(authority, { kind: 'upload', hostPath: upload, sourcePath: source });
      expect([...fs.readFileSync(upload)]).toEqual([0, 1, 2, 255]);

      const dir = path.join(root, 'work', 'folder');
      mirrorWorkerProjectMutation(authority, { kind: 'mkdir', hostPath: dir });
      expect(fs.statSync(dir).isDirectory()).toBe(true);

      const renamed = path.join(root, 'notes', 'renamed.md');
      mirrorWorkerProjectMutation(authority, { kind: 'rename', oldHostPath: text, newHostPath: renamed });
      expect(fs.existsSync(text)).toBe(false);
      expect(fs.readFileSync(renamed, 'utf8')).toBe('# A');

      const copied = path.join(root, 'notes', 'copied.md');
      mirrorWorkerProjectMutation(authority, { kind: 'copy', sourceHostPath: renamed, targetHostPath: copied });
      expect(fs.readFileSync(copied, 'utf8')).toBe('# A');

      mirrorWorkerProjectMutation(authority, { kind: 'delete', hostPath: copied });
      expect(fs.existsSync(copied)).toBe(false);
    } finally {
      fs.rmSync(source, { force: true });
    }
  });

  it('fails closed on paths outside the Project but keeps mirror failures best-effort', () => {
    const { root, authority } = setup();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outside = path.join(path.dirname(root), 'outside.md');
    mirrorWorkerProjectMutation(authority, { kind: 'write-text', hostPath: outside, content: 'no' });
    expect(fs.existsSync(outside)).toBe(false);
    expect(warning).toHaveBeenCalledWith('[worker-project-derived-mirror] update failed', expect.objectContaining({
      projectId: 'project-1',
      kind: 'write-text',
      error: 'WORKER_DERIVED_MIRROR_PATH_OUTSIDE_PROJECT',
    }));
  });
});
