import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getFileTree, getFileTreeAsync, invalidateTreeCache, isDefaultHiddenFileTreeEntry } from './file-system.js';

const createdDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-file-tree-'));
  createdDirs.push(dir);
  return dir;
}

function touch(filePath: string): void {
  fs.writeFileSync(filePath, 'x', 'utf8');
}

afterEach(() => {
  invalidateTreeCache();
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace file tree visibility', () => {
  it('classifies project contract files as default-hidden entries', () => {
    expect(isDefaultHiddenFileTreeEntry('AGENTS.md')).toBe(true);
    expect(isDefaultHiddenFileTreeEntry('CLAUDE.md')).toBe(true);
    expect(isDefaultHiddenFileTreeEntry('SOUL.md')).toBe(true);
    expect(isDefaultHiddenFileTreeEntry('SCAFFOLDING.md')).toBe(true);
    expect(isDefaultHiddenFileTreeEntry('README.md')).toBe(false);
  });

  it('hides dot folders and project contract files from the default sync file tree', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, '.wiki'));
    touch(path.join(dir, 'AGENTS.md'));
    touch(path.join(dir, 'SOUL.md'));
    touch(path.join(dir, 'report.md'));

    const entries = getFileTree(dir, 2, { skipSafetyCheck: true });
    expect(entries.map((e) => e.name)).toEqual(['report.md']);

    const visibleWithHidden = getFileTree(dir, 2, { skipSafetyCheck: true, showHidden: true }).map((e) => e.name);
    expect(visibleWithHidden).toContain('.wiki');
    expect(visibleWithHidden).toContain('AGENTS.md');
    expect(visibleWithHidden).toContain('SOUL.md');
    expect(visibleWithHidden).toContain('report.md');
  });

  it('hides dot folders and project contract files from the default async file tree', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, '.project'));
    touch(path.join(dir, 'CLAUDE.md'));
    touch(path.join(dir, 'SCAFFOLDING.md'));
    touch(path.join(dir, 'notes.md'));

    const entries = await getFileTreeAsync(dir, 2, { skipSafetyCheck: true });
    expect(entries.map((e) => e.name)).toEqual(['notes.md']);

    const visibleWithHidden = (await getFileTreeAsync(dir, 2, { skipSafetyCheck: true, showHidden: true })).map((e) => e.name);
    expect(visibleWithHidden).toContain('.project');
    expect(visibleWithHidden).toContain('CLAUDE.md');
    expect(visibleWithHidden).toContain('SCAFFOLDING.md');
    expect(visibleWithHidden).toContain('notes.md');
  });

  it('invalidates cached hidden and visible variants when an entry moves', async () => {
    const dir = makeTempDir();
    const sourceDir = path.join(dir, 'source');
    const targetDir = path.join(dir, 'target');
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(targetDir);
    const sourceFile = path.join(sourceDir, 'note.md');
    const targetFile = path.join(targetDir, 'note.md');
    touch(sourceFile);

    await getFileTreeAsync(sourceDir, 2, { skipSafetyCheck: true });
    await getFileTreeAsync(sourceDir, 2, { skipSafetyCheck: true, showHidden: true });
    await getFileTreeAsync(targetDir, 2, { skipSafetyCheck: true });

    fs.renameSync(sourceFile, targetFile);
    invalidateTreeCache(sourceFile);
    invalidateTreeCache(targetFile);

    expect((await getFileTreeAsync(sourceDir, 2, { skipSafetyCheck: true })).map((e) => e.name)).toEqual([]);
    expect((await getFileTreeAsync(sourceDir, 2, { skipSafetyCheck: true, showHidden: true })).map((e) => e.name)).toEqual([]);
    expect((await getFileTreeAsync(targetDir, 2, { skipSafetyCheck: true })).map((e) => e.name)).toEqual(['note.md']);
  });
});


describe('directory symlink listings', () => {
  it('classifies linked folders by their target in both listing implementations', async () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, 'target'));
    fs.symlinkSync('target', path.join(root, '0905-강연'));
    fs.writeFileSync(path.join(root, 'README'), 'extensionless file');
    for (const entries of [getFileTree(root, 1, { skipSafetyCheck: true }), await getFileTreeAsync(root, 1, { skipSafetyCheck: true })]) {
      const link = entries.find(entry => entry.name === '0905-강연');
      expect(link?.isDirectory).toBe(true);
      expect(link?.size).toBeUndefined();
      expect(link?.extension).toBeUndefined();
      expect(entries.find(entry => entry.name === 'README')?.isDirectory).toBe(false);
    }
  });
});
