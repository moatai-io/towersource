import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSharedStorageSmokeIdentity, verifySharedProjectStorage } from './workbench-project-shared-storage-smoke.js';
import { receiveWorkerProjectFileUpload } from './worker-project-file-upload.js';

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); vi.restoreAllMocks(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-shared-smoke-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'existing.txt'), 'unchanged', { mode: 0o600 });
  return {
    root, backendUid: process.getuid(),
    execute: vi.fn(async (command: string) => { await run('/bin/sh', ['-c', command], { cwd: root }); }),
    upload: vi.fn(async (relativePath: string, content: string) => {
      await receiveWorkerProjectFileUpload({ target: path.join(root, relativePath), expectedBytes: Buffer.byteLength(content), chunks: (async function* () { yield content; })() });
    }),
  };
}

describe('automatic shared-storage assignment evidence', () => {
  it('requires explicit non-root backend identity, never an inferred project owner', () => {
    expect(() => assertSharedStorageSmokeIdentity(NaN)).toThrow('BACKEND_UID_REQUIRED');
    expect(() => assertSharedStorageSmokeIdentity(0)).toThrow('BACKEND_UID_REQUIRED');
    expect(() => assertSharedStorageSmokeIdentity(process.getuid() + 1)).toThrow('BACKEND_SERVICE_IDENTITY');
  });

  it.skipIf(process.getuid() === 0)('round-trips backend writes, worker mkdir/file and actual upload with cleanup', async () => {
    const input = await fixture();
    await verifySharedProjectStorage(input);
    expect(input.execute).toHaveBeenCalledTimes(2);
    expect(input.upload).toHaveBeenCalledOnce();
    expect(await fs.readdir(input.root)).toEqual(['existing.txt']);
    expect(await fs.readFile(path.join(input.root, 'existing.txt'), 'utf8')).toBe('unchanged');
    expect((await fs.stat(path.join(input.root, 'existing.txt'))).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.getuid() === 0)('blocks unavailable static HTTP file scope even when shell works', async () => {
    const input = await fixture();
    input.upload.mockRejectedValueOnce(new Error('HTTP_403'));
    await expect(verifySharedProjectStorage(input)).rejects.toThrow('HTTP_403');
    expect(input.execute).toHaveBeenCalledOnce();
    expect(await fs.readdir(input.root)).toEqual(['existing.txt']);
  });

  it.skipIf(process.getuid() === 0)('blocks a Worker which cannot access Backend-created data', async () => {
    const input = await fixture();
    input.execute.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(verifySharedProjectStorage(input)).rejects.toThrow('Permission denied');
    expect(input.upload).not.toHaveBeenCalled();
    expect(await fs.readdir(input.root)).toEqual(['existing.txt']);
  });

  it.skipIf(process.getuid() === 0)('does not classify isolated Worker storage as a shared Project filesystem', async () => {
    const input = await fixture();
    // Remote Worker reports success but its writes are not on this filesystem.
    input.execute.mockResolvedValue(undefined);
    await expect(verifySharedProjectStorage(input)).rejects.toThrow('WORKER_WRITE_FAILED');
    expect(input.upload).not.toHaveBeenCalled();
    expect(await fs.readdir(input.root)).toEqual(['existing.txt']);
  });

  it.skipIf(process.getuid() === 0)('blocks backend write failures without repairing user ACLs', async () => {
    const input = await fixture();
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('EACCES'));
    await expect(verifySharedProjectStorage(input)).rejects.toThrow('EACCES');
    expect(append).toHaveBeenCalledOnce();
    expect(input.upload).not.toHaveBeenCalled();
    expect(await fs.readdir(input.root)).toEqual(['existing.txt']);
  });

  it.skipIf(process.getuid() === 0)('rejects a symlink root before synthetic writes', async () => {
    const input = await fixture();
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-smoke-link-'));
    roots.push(parent);
    const link = path.join(parent, 'linked');
    await fs.symlink(input.root, link);
    await expect(verifySharedProjectStorage({ ...input, root: link })).rejects.toThrow('REAL_DIRECTORY');
    expect(input.execute).not.toHaveBeenCalled();
    expect(await fs.readdir(input.root)).toEqual(['existing.txt']);
  });
});
