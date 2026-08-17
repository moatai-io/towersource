import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyRemoteWorkspaceDelta, snapshotWorkspace } from './workbench-remote-workspace-sync.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-remote-sync-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const staged = path.join(root, 'staged');
  await fs.mkdir(path.join(project, 'work'), { recursive: true });
  await fs.mkdir(path.join(staged, 'work'), { recursive: true });
  await fs.writeFile(path.join(project, 'work', 'input.txt'), 'baseline\n');
  await fs.cp(project, staged, { recursive: true });
  return { project, staged };
}

describe('Remote Workbench workspace materialization', () => {
  it('applies changed and new staged files while ignoring unchanged input', async () => {
    const { project, staged } = await fixture();
    const snapshot = await snapshotWorkspace(project);
    await fs.writeFile(path.join(staged, 'work', 'input.txt'), 'worker-change\n');
    await fs.writeFile(path.join(staged, 'work', 'output.txt'), 'worker-output\n');
    await expect(applyRemoteWorkspaceDelta({ snapshot, stagedRoot: staged })).resolves.toEqual({
      applied: ['work/input.txt', 'work/output.txt'], unchanged: [], conflicts: [],
    });
    await expect(fs.readFile(path.join(project, 'work', 'input.txt'), 'utf8')).resolves.toBe('worker-change\n');
  });

  it('fails closed when Tower changed the same file after dispatch', async () => {
    const { project, staged } = await fixture();
    const snapshot = await snapshotWorkspace(project);
    await fs.writeFile(path.join(project, 'work', 'input.txt'), 'tower-newer\n');
    await fs.writeFile(path.join(staged, 'work', 'input.txt'), 'worker-change\n');
    await expect(applyRemoteWorkspaceDelta({ snapshot, stagedRoot: staged })).rejects.toMatchObject({
      message: 'REMOTE_WORKSPACE_CONFLICT: work/input.txt',
      result: { conflicts: ['work/input.txt'] },
    });
    await expect(fs.readFile(path.join(project, 'work', 'input.txt'), 'utf8')).resolves.toBe('tower-newer\n');
  });

  it('does not snapshot or materialize control and dependency directories', async () => {
    const { project, staged } = await fixture();
    await fs.mkdir(path.join(project, '.tower'), { recursive: true });
    await fs.writeFile(path.join(project, '.tower', 'secret'), 'never');
    const snapshot = await snapshotWorkspace(project);
    expect(snapshot.files).not.toHaveProperty('.tower/secret');
    await fs.mkdir(path.join(staged, '.tower'), { recursive: true });
    await fs.writeFile(path.join(staged, '.tower', 'worker'), 'never');
    await expect(applyRemoteWorkspaceDelta({ snapshot, stagedRoot: staged })).resolves.toMatchObject({ conflicts: [] });
    await expect(fs.access(path.join(project, '.tower', 'worker'))).rejects.toThrow();
  });
});
