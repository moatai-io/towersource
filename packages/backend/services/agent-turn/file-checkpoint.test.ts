import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyFilesOnlyRestore, previewFilesOnlyRestore, snapshotFile, type CheckpointFileChange } from './file-checkpoint.js';

const roots: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'tower-checkpoint-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

async function change(projectRoot: string, filePath: string, beforeText: string | null, afterText: string | null): Promise<CheckpointFileChange> {
  if (beforeText !== null) { await mkdir(join(projectRoot, 'nested'), { recursive: true }); await writeFile(filePath, beforeText); }
  const before = await snapshotFile(projectRoot, filePath);
  if (afterText === null) await rm(filePath, { force: true });
  else { await mkdir(join(projectRoot, 'nested'), { recursive: true }); await writeFile(filePath, afterText); }
  return { filePath, before, after: await snapshotFile(projectRoot, filePath) };
}

describe('turn file checkpoint restore', () => {
  it('restores update', async () => {
    const projectRoot = await root(); const filePath = join(projectRoot, 'nested', 'a.txt');
    const c = await change(projectRoot, filePath, 'before', 'after');
    const p = await previewFilesOnlyRestore(projectRoot, [c]);
    expect(p.items[0]).toMatchObject({ action: 'update', status: 'ready' });
    await applyFilesOnlyRestore({ projectRoot, changes: [c], previewHash: p.previewHash });
    expect(await readFile(filePath, 'utf8')).toBe('before');
  });

  it('removes a file created by the turn', async () => {
    const projectRoot = await root(); const filePath = join(projectRoot, 'new.txt');
    const c = await change(projectRoot, filePath, null, 'created');
    const p = await previewFilesOnlyRestore(projectRoot, [c]);
    expect(p.items[0].action).toBe('delete');
    await applyFilesOnlyRestore({ projectRoot, changes: [c], previewHash: p.previewHash });
    expect((await snapshotFile(projectRoot, filePath)).exists).toBe(false);
  });

  it('recreates a file deleted by the turn', async () => {
    const projectRoot = await root(); const filePath = join(projectRoot, 'deleted.txt');
    const c = await change(projectRoot, filePath, 'original', null);
    const p = await previewFilesOnlyRestore(projectRoot, [c]);
    expect(p.items[0].action).toBe('create');
    await applyFilesOnlyRestore({ projectRoot, changes: [c], previewHash: p.previewHash });
    expect(await readFile(filePath, 'utf8')).toBe('original');
  });

  it('detects a later user change and refuses restore', async () => {
    const projectRoot = await root(); const filePath = join(projectRoot, 'conflict.txt');
    const c = await change(projectRoot, filePath, 'before', 'agent-after');
    await writeFile(filePath, 'later-user-change');
    const p = await previewFilesOnlyRestore(projectRoot, [c]);
    expect(p).toMatchObject({ canApply: false });
    expect(p.items[0].status).toBe('conflict');
    await expect(applyFilesOnlyRestore({ projectRoot, changes: [c], previewHash: p.previewHash })).rejects.toThrow('checkpoint_restore_conflict');
    expect(await readFile(filePath, 'utf8')).toBe('later-user-change');
  });

  it('rejects stale previews', async () => {
    const projectRoot = await root(); const filePath = join(projectRoot, 'stale.txt');
    const c = await change(projectRoot, filePath, 'before', 'after');
    await expect(applyFilesOnlyRestore({ projectRoot, changes: [c], previewHash: 'stale' })).rejects.toThrow('checkpoint_preview_stale');
  });

  it('rejects paths outside project and protected git paths', async () => {
    const projectRoot = await root();
    await expect(snapshotFile(projectRoot, join(projectRoot, '..', 'outside.txt'))).rejects.toThrow('checkpoint_path_outside_project');
    await expect(snapshotFile(projectRoot, join(projectRoot, '.git', 'config'))).rejects.toThrow('checkpoint_path_protected');
  });
});
