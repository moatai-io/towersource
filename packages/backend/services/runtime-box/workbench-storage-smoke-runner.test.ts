import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBackendStorageSmoke } from './workbench-storage-smoke-runner.js';
import { assertBackendStorageIdentity, enterBackendStorageIdentity, sharedStorageVerificationConfig, verifyBackendProcessIdentity } from './workbench-storage-smoke-identity.js';
import { receiveWorkerProjectFileUpload } from './worker-project-file-upload.js';
const run = promisify(execFile);
const identity = () => ({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), umask: process.umask() });
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('storage smoke configuration and identity', () => {
  it('preserves legacy root and signed-grant assignment without claiming upload readiness', () => {
    expect(sharedStorageVerificationConfig({}, false)).toEqual({ status: 'unverified', reason: 'not-enabled' });
    expect(sharedStorageVerificationConfig({ TOWER_ASSIGNMENT_VERIFY_SHARED_STORAGE: 'true' }, true)).toEqual({ status: 'unverified', reason: 'signed-grant-no-static-upload-scope' });
    expect(() => sharedStorageVerificationConfig({ TOWER_ASSIGNMENT_VERIFY_SHARED_STORAGE: 'true' }, false)).toThrow('IDENTITY_INVALID');
  });
  it('requires full explicit identity only for opt-in static-scope verification', () => {
    const expected = { uid: 1234, gid: 1234, groups: [1234, 5555], umask: 0o022 };
    expect(sharedStorageVerificationConfig({ TOWER_ASSIGNMENT_VERIFY_SHARED_STORAGE: 'true', TOWER_ASSIGNMENT_BACKEND_IDENTITY: JSON.stringify(expected), TOWER_ASSIGNMENT_BACKEND_PID: '123' }, false)).toEqual({ status: 'required', identity: expected, backendPid: 123 });
    for (const value of [null, { ...expected, uid: 0 }, { ...expected, gid: 0 }, { ...expected, groups: [0] }, { ...expected, umask: -1 }]) {
      expect(() => sharedStorageVerificationConfig({ TOWER_ASSIGNMENT_VERIFY_SHARED_STORAGE: 'true', TOWER_ASSIGNMENT_BACKEND_IDENTITY: JSON.stringify(value) }, false)).toThrow('IDENTITY_INVALID');
    }
  });
  it.skipIf(process.getuid() === 0)('checks real/effective UID/GID and supplementary groups for non-root calls', () => {
    const value = identity();
    expect(() => assertBackendStorageIdentity(value)).not.toThrow();
    expect(() => assertBackendStorageIdentity({ ...value, gid: value.gid + 1 })).toThrow('IDENTITY_MISMATCH');
    expect(() => assertBackendStorageIdentity({ ...value, groups: [...value.groups, 98765] })).toThrow('IDENTITY_MISMATCH');
  });
  it.skipIf(process.getuid() === 0)('matches an explicitly selected live PID and refuses mismatched identity', () => {
    expect(() => verifyBackendProcessIdentity(process.pid, identity())).not.toThrow();
    expect(() => verifyBackendProcessIdentity(process.pid, { ...identity(), umask: process.umask() ^ 0o002 })).toThrow('PROCESS_IDENTITY_MISMATCH');
  });
  it('drops groups then GID then UID and verifies the resulting identity (no actual elevation)', () => {
    let uid = 0; let gid = 0; let groups = [0];
    const events: string[] = [];
    vi.spyOn(process, 'getuid').mockImplementation(() => uid);
    vi.spyOn(process, 'geteuid').mockImplementation(() => uid);
    vi.spyOn(process, 'getgid').mockImplementation(() => gid);
    vi.spyOn(process, 'getegid').mockImplementation(() => gid);
    vi.spyOn(process, 'getgroups').mockImplementation(() => groups);
    vi.spyOn(process, 'setgroups').mockImplementation(value => { events.push('groups'); groups = value as number[]; });
    vi.spyOn(process, 'setgid').mockImplementation(value => { events.push('gid'); gid = value as number; });
    vi.spyOn(process, 'setuid').mockImplementation(value => { events.push('uid'); uid = value as number; });
    vi.spyOn(process, 'umask').mockImplementation(() => { events.push('umask'); return 0o022; });
    enterBackendStorageIdentity({ uid: 1234, gid: 2345, groups: [3456], umask: 0o002 });
    expect(events).toEqual(['groups', 'gid', 'uid', 'umask']);
  });
  it('does not attempt any elevation for a non-root mismatched identity', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1234);
    const setuid = vi.spyOn(process, 'setuid').mockImplementation(() => { throw new Error('must not call'); });
    expect(() => enterBackendStorageIdentity({ uid: 2345, gid: 2345, groups: [2345], umask: 0o022 })).toThrow('IDENTITY_MISMATCH');
    expect(setuid).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.getuid() === 0)('dedicated Backend child smoke integration', () => {
  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-child-smoke-')); roots.push(root);
    return { root, identity: identity(),
      execute: vi.fn(async (command: string) => { await run('/bin/sh', ['-c', command], { cwd: root }); }),
      upload: vi.fn(async (relativePath: string, content: string) => { await receiveWorkerProjectFileUpload({ target: path.join(root, relativePath), expectedBytes: Buffer.byteLength(content), chunks: (async function* () { yield content; })() }); }),
    };
  }
  it('executes filesystem roundtrips in a real child and leaves the privileged parent identity unchanged', async () => {
    const input = await fixture();
    const before = identity();
    await runBackendStorageSmoke(input);
    expect(identity()).toEqual(before);
    expect(input.execute).toHaveBeenCalledTimes(2);
    expect(input.upload).toHaveBeenCalledOnce();
    expect(await fs.readdir(input.root)).toEqual([]);
  });
  it('propagates a denied transport probe without claiming verification', async () => {
    const input = await fixture();
    input.upload.mockRejectedValueOnce(new Error('denied'));
    await expect(runBackendStorageSmoke(input)).rejects.toThrow('BACKEND_PROBE_FAILED');
    expect(await fs.readdir(input.root)).toEqual([]);
  });
});
