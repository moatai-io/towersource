import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyStaticPublication, normalizePublishedModes } from './static-publish-files.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-modes-')); roots.push(root);
  const source = path.join(root, 'source'); const destination = path.join(root, 'published');
  await fs.mkdir(path.join(source, 'assets'), { recursive: true });
  await fs.writeFile(path.join(source, 'index.html'), '<h1>test</h1>', { mode: 0o660 });
  await fs.writeFile(path.join(source, 'assets/app.js'), 'export {}', { mode: 0o600 });
  await fs.chmod(path.join(source, 'index.html'), 0o660);
  await fs.chmod(path.join(source, 'assets'), 0o700);
  return { root, source, destination };
}
const mode = async (p: string) => (await fs.stat(p)).mode & 0o777;
describe('static publication copy permissions', () => {
  it('makes copied files readable and directories traversable without changing source modes', async () => {
    const { source, destination } = await fixture();
    await fs.mkdir(path.join(source, 'node_modules'));
    await fs.mkdir(path.join(source, '.git'));
    await copyStaticPublication(source, destination);
    expect(await mode(destination)).toBe(0o755);
    expect(await mode(path.join(destination, 'assets'))).toBe(0o755);
    expect(await mode(path.join(destination, 'index.html'))).toBe(0o644);
    expect(await mode(path.join(destination, 'assets/app.js'))).toBe(0o644);
    expect(await mode(path.join(source, 'index.html'))).toBe(0o660);
    expect(await mode(path.join(source, 'assets'))).toBe(0o700);
    expect(await fs.readdir(destination)).toEqual(expect.not.arrayContaining(['.git', 'node_modules']));
  });
  it('rejects overlapping paths before touching the source', async () => {
    const { root, source } = await fixture();
    for (const dest of [source, path.join(source, 'output'), root]) {
      await expect(copyStaticPublication(source, dest)).rejects.toThrow('must not overlap');
    }
    expect(await mode(path.join(source, 'index.html'))).toBe(0o660);
  });
  it('refuses to chmod symlink targets', async () => {
    const { source, destination } = await fixture();
    await fs.mkdir(destination);
    await fs.symlink(path.join(source, 'index.html'), path.join(destination, 'link'));
    await expect(normalizePublishedModes(destination)).rejects.toThrow('symbolic links');
    expect(await mode(path.join(source, 'index.html'))).toBe(0o660);
  });
});
