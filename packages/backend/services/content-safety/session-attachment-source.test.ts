import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../session-attachments/session-attachment-store.js', () => ({ resolveAuthorizedSessionAttachment: mocks.resolve }));
import { prepareFileRepresentation, readPreparedFileBytes, withPreparedLocalFile } from './file-representation-gateway.js';
const roots: string[] = [];
afterEach(async () => { mocks.resolve.mockReset(); await Promise.all(roots.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function fixture(extension = 'txt') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-attachment-source-')); roots.push(root);
  const file = path.join(root, `synthetic.${extension}`); await fs.writeFile(file, 'synthetic bytes');
  mocks.resolve.mockResolvedValue({ path: file, document: { name: path.basename(file) } });
  const source = { stat: vi.fn(), readProbe: vi.fn(), readFile: vi.fn() };
  const prepared = await prepareFileRepresentation('session://attachments/test', { cwd: root, sessionId: 'shared', userId: 8, projectRoot: '/other', projectSource: source });
  return { root, file, source, prepared };
}
describe('one ephemeral session source for every format', () => {
  it.each(['txt','pdf','xlsx','docx','dxf','opaque'])('reauthorizes %s bytes and stages privately without Project operations', async extension => {
    const { root, file, source, prepared } = await fixture(extension);
    expect((await readPreparedFileBytes(prepared, source, 1024)).toString()).toBe('synthetic bytes');
    let staged = '';
    await withPreparedLocalFile(prepared, source, 1024, async local => {
      staged = local; expect(local).not.toBe(file); expect((await fs.stat(local)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(local, 'utf8')).toBe('synthetic bytes');
    });
    await expect(fs.stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(source.readFile).not.toHaveBeenCalled(); expect(source.stat).not.toHaveBeenCalled();
    expect(mocks.resolve).toHaveBeenCalledTimes(3); expect(await fs.readdir(root)).toEqual([`synthetic.${extension}`]);
  });
  it.each(['FORBIDDEN','EXPIRED','NOT_FOUND'])('does not consume or stage bytes after %s', async code => {
    const { source, prepared } = await fixture(); mocks.resolve.mockRejectedValue(new Error(code));
    await expect(readPreparedFileBytes(prepared, source, 1024)).rejects.toThrow(code);
    const use = vi.fn(); await expect(withPreparedLocalFile(prepared, source, 1024, use)).rejects.toThrow(code);
    expect(use).not.toHaveBeenCalled(); expect(source.readFile).not.toHaveBeenCalled();
  });
  it('rejects fabricated capabilities and source path changes', async () => {
    const { file, prepared } = await fixture();
    await expect(readPreparedFileBytes({ ...prepared }, undefined, 1024)).rejects.toThrow('CAPABILITY_REQUIRED');
    mocks.resolve.mockResolvedValue({ path: file + '.other', document: { name: 'synthetic.txt' } });
    await expect(readPreparedFileBytes(prepared, undefined, 1024)).rejects.toThrow('SOURCE_CHANGED');
  });
  it('bounds actual bytes and cleans parser stages on error', async () => {
    const { file, prepared } = await fixture(); await fs.writeFile(file, 'x'.repeat(300));
    await expect(readPreparedFileBytes(prepared, undefined, 30)).rejects.toThrow('LIMIT_EXCEEDED');
    await fs.writeFile(file, 'synthetic bytes'); let stage = '';
    await expect(withPreparedLocalFile(prepared, undefined, 30, async p => { stage = p; throw new Error('parser failed'); })).rejects.toThrow('parser failed');
    await expect(fs.stat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a final symlink instead of reading another file', async () => {
    const { root, file, prepared } = await fixture(); await fs.rename(file, path.join(root,'original')); await fs.symlink(path.join(root,'original'), file);
    await expect(readPreparedFileBytes(prepared, undefined, 1024)).rejects.toMatchObject({ code: 'ELOOP' });
  });
});
