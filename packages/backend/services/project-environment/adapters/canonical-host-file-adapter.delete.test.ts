import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteCanonicalProjectEntry } from './canonical-host-file-adapter.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-delete-'));
  roots.push(base);
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  return { base, root };
}

describe('canonical host entry deletion', () => {
  it.each(['file', 'directory', 'dangling'] as const)('unlinks a %s symlink without touching its outside target', (kind) => {
    const { base, root } = fixture();
    const target = path.join(base, 'original');
    if (kind === 'directory') { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'original'); }
    if (kind === 'file') fs.writeFileSync(target, 'original');
    const link = path.join(root, 'alias');
    fs.symlinkSync(target, link);
    deleteCanonicalProjectEntry(root, 'alias');
    expect(() => fs.lstatSync(link)).toThrow();
    if (kind === 'file') expect(fs.readFileSync(target, 'utf8')).toBe('original');
    if (kind === 'directory') expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('original');
  });

  it('rejects traversal through a symlink ancestor', () => {
    const { base, root } = fixture();
    const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'original');
    fs.symlinkSync(outside, path.join(root, 'alias'));
    expect(() => deleteCanonicalProjectEntry(root, 'alias/keep')).toThrow('WORKSPACE_WRITE_UNSAFE_ANCESTOR');
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('original');
  });

  it('rejects project root and parent traversal', () => {
    const { root } = fixture();
    for (const relative of ['.', '../outside', 'a/../b']) {
      expect(() => deleteCanonicalProjectEntry(root, relative)).toThrow('WORKSPACE_WRITE_PATH_INVALID');
    }
  });

  it('still deletes regular files and directories', () => {
    const { root } = fixture();
    fs.writeFileSync(path.join(root, 'file'), 'data');
    fs.mkdirSync(path.join(root, 'dir')); fs.writeFileSync(path.join(root, 'dir', 'file'), 'data');
    deleteCanonicalProjectEntry(root, 'file'); deleteCanonicalProjectEntry(root, 'dir');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
