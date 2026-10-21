import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServerMailVirtualKey } from './server-mail-key.js';
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });
describe('server-only mail key file', () => {
  it('reads owner-only external file without exposing it in config', async () => {
    root = await mkdtemp(join(tmpdir(), 'mail-key-test-'));
    const source = join(root, 'source'); await mkdir(source);
    const file = join(root, 'mail.key'); await writeFile(file, 'synthetic-key\n', { mode: 0o600 });
    expect(await readServerMailVirtualKey(file, source)).toBe('synthetic-key');
  });
  it('rejects in-tree, world-readable and symlink files', async () => {
    root = await mkdtemp(join(tmpdir(), 'mail-key-test-'));
    const source = join(root, 'source'); await mkdir(source);
    const inside = join(source, 'mail.key'); await writeFile(inside, 'synthetic-key', { mode: 0o600 });
    await expect(readServerMailVirtualKey(inside, source)).rejects.toThrow('outside source tree');
    const file = join(root, 'mail.key'); await writeFile(file, 'synthetic-key', { mode: 0o600 });
    await chmod(file, 0o644);
    await expect(readServerMailVirtualKey(file, source)).rejects.toThrow('permissions');
    await chmod(file, 0o600);
    const link = join(root, 'link.key'); await symlink(file, link);
    await expect(readServerMailVirtualKey(link, source)).rejects.toThrow('permissions');
  });
  it('rejects dot-prefixed source children and reads replacements without caching', async () => {
    root = await mkdtemp(join(tmpdir(), 'mail-key-test-'));
    const source = join(root, 'source'); await mkdir(source);
    const hidden = join(source, '..keys'); await mkdir(hidden);
    const inside = join(hidden, 'mail.key'); await writeFile(inside, 'synthetic-key', { mode: 0o600 });
    await expect(readServerMailVirtualKey(inside, source)).rejects.toThrow('outside source tree');
    const file = join(root, 'mail.key'); await writeFile(file, 'synthetic-first', { mode: 0o600 });
    expect(await readServerMailVirtualKey(file, source)).toBe('synthetic-first');
    await writeFile(file, 'synthetic-second');
    expect(await readServerMailVirtualKey(file, source)).toBe('synthetic-second');
    await writeFile(file, 'x'.repeat(4097));
    await expect(readServerMailVirtualKey(file, source)).rejects.toThrow();
  });

});
