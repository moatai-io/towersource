import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareAndSwapCanonicalProjectText, copyCanonicalProjectEntry, renameCanonicalProjectEntry, readCanonicalProjectFileBytes, createCanonicalProjectDirectory, writeCanonicalProjectText } from './canonical-host-file-adapter.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const supported = process.platform === 'linux' && spawnSync('setfacl', ['--version']).status === 0;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-acl-')); roots.push(root);
  // Synthetic second identity; metadata only, no privileged process or customer data.
  const peer = process.getuid!() === 65534 ? 65533 : 65534;
  execFileSync('setfacl', ['-m', `u:${peer}:rwx,d:u:${peer}:rwx,d:m::rwx,d:o::---`, root]);
  return { root, peer };
}
function effectivePeerWrite(file: string, peer: number) {
  const acl = execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' });
  const entry = acl.split('\n').find(line => line.startsWith(`user:${peer}:`))!;
  const mask = acl.split('\n').find(line => line.startsWith('mask::'))!;
  return !!entry && entry.split(':')[2].includes('w') && mask.split(':')[2].includes('w');
}
describe.skipIf(!supported)('canonical ordinary file ACL inheritance', () => {
  it('preserves peer write on auto-created ancestors and upload replacement', async () => {
    const { root, peer } = fixture();
    writeCanonicalProjectText(root, 'auto/nested/report.md', 'first', true);
    expect(effectivePeerWrite(path.join(root, 'auto'), peer)).toBe(true);
    expect(effectivePeerWrite(path.join(root, 'auto/nested'), peer)).toBe(true);
    expect(effectivePeerWrite(path.join(root, 'auto/nested/report.md'), peer)).toBe(true);
    const { receiveWorkerProjectFileUpload } = await import('../../runtime-box/worker-project-file-upload.js');
    const target = path.join(root, 'auto/nested/report.md');
    await receiveWorkerProjectFileUpload({ target, expectedBytes: 6, chunks: (async function* () { yield 'upload'; })() });
    expect(effectivePeerWrite(target, peer)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('upload');
  });
  it.each([true, false])('keeps nested explicit mkdir peer-writable (exclusive=%s)', exclusive => {
    const { root, peer } = fixture();
    createCanonicalProjectDirectory(root, 'parent/child', exclusive);
    expect(effectivePeerWrite(path.join(root, 'parent'), peer)).toBe(true);
    expect(effectivePeerWrite(path.join(root, 'parent/child'), peer)).toBe(true);
  });
  it('keeps peer access through rename to newly created ancestor directories', () => {
    const { root, peer } = fixture();
    writeCanonicalProjectText(root, 'source.md', 'content', true);
    renameCanonicalProjectEntry(root, 'source.md', 'renamed/deep/report.md');
    for (const relative of ['renamed', 'renamed/deep', 'renamed/deep/report.md']) expect(effectivePeerWrite(path.join(root, relative), peer)).toBe(true);
  });
  it('keeps ordinary shared copies accessible but does not widen explicitly private copies', () => {
    const { root, peer } = fixture();
    writeCanonicalProjectText(root, 'source/report.md', 'shared', true);
    createCanonicalProjectDirectory(root, 'destination');
    const copied = copyCanonicalProjectEntry(root, 'source', 'destination');
    expect(effectivePeerWrite(path.join(root, copied), peer)).toBe(true);
    expect(effectivePeerWrite(path.join(root, copied, 'report.md'), peer)).toBe(true);
    fs.writeFileSync(path.join(root, 'private.md'), 'private', { mode: 0o600 });
    const privateCopy = copyCanonicalProjectEntry(root, 'private.md', 'destination');
    expect(effectivePeerWrite(path.join(root, privateCopy), peer)).toBe(false);
  });
  it('inherits peer ACL through upload-created ancestors and preserves a private replacement mask', async () => {
    const { root, peer } = fixture();
    const { receiveWorkerProjectFileUpload } = await import('../../runtime-box/worker-project-file-upload.js');
    const target = path.join(root, 'uploaded/deep/report.md');
    await receiveWorkerProjectFileUpload({ target, expectedBytes: 3, chunks: (async function* () { yield 'new'; })() });
    for (const relative of ['uploaded', 'uploaded/deep', 'uploaded/deep/report.md']) expect(effectivePeerWrite(path.join(root, relative), peer)).toBe(true);
    fs.chmodSync(target, 0o600);
    await receiveWorkerProjectFileUpload({ target, expectedBytes: 4, chunks: (async function* () { yield 'next'; })() });
    expect(effectivePeerWrite(target, peer)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('next');
  });
  it('allows the peer to write new files under a nested inherited directory', () => {
    const { root, peer } = fixture();
    createCanonicalProjectDirectory(root, 'nested');
    writeCanonicalProjectText(root, 'nested/report.md', 'first', true);
    expect(effectivePeerWrite(path.join(root, 'nested/report.md'), peer)).toBe(true);
    expect(fs.statSync(path.join(root, 'nested/report.md')).mode & 0o007).toBe(0);
  });
  it('keeps peer write access after atomic replacement of an ordinary shared file', () => {
    const { root, peer } = fixture();
    fs.writeFileSync(path.join(root, 'report.md'), 'first', { mode: 0o660 });
    expect(effectivePeerWrite(path.join(root, 'report.md'), peer)).toBe(true);
    compareAndSwapCanonicalProjectText(root, 'report.md', 'first', 'second');
    expect(effectivePeerWrite(path.join(root, 'report.md'), peer)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'report.md'), 'utf8')).toBe('second');
  });
  it('does not widen private files during a direct overwrite', () => {
    const { root, peer } = fixture();
    fs.writeFileSync(path.join(root, 'private.md'), 'first', { mode: 0o600 });
    writeCanonicalProjectText(root, 'private.md', 'second');
    expect(fs.statSync(path.join(root, 'private.md')).mode & 0o777).toBe(0o600);
    expect(effectivePeerWrite(path.join(root, 'private.md'), peer)).toBe(false);
  });
  it('does not widen a deliberately private existing file on replacement', () => {
    const { root, peer } = fixture();
    fs.writeFileSync(path.join(root, 'private.md'), 'first', { mode: 0o600 });
    compareAndSwapCanonicalProjectText(root, 'private.md', 'first', 'second');
    expect(fs.statSync(path.join(root, 'private.md')).mode & 0o777).toBe(0o600);
    expect(effectivePeerWrite(path.join(root, 'private.md'), peer)).toBe(false);
  });

  it('preserves a file-only named-user read grant across atomic replacement', () => {
    const { root, peer } = fixture();
    const file = path.join(root, 'published.md');
    fs.writeFileSync(file, 'first', { mode: 0o600 });
    execFileSync('setfacl', ['-b', file]);
    execFileSync('setfacl', ['-m', `u:${peer}:r--`, file]);
    const before = execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' });
    compareAndSwapCanonicalProjectText(root, 'published.md', 'first', 'second');
    expect(execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' })).toBe(before);
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
  });

  it('rejects a Project-controlled ACL tool before publication', () => {
    const { root } = fixture(); const file = path.join(root, 'private.md'); fs.writeFileSync(file, 'first', { mode: 0o600 });
    const before = execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' });
    vi.stubEnv('TOWER_PROJECT_SETFACL_BIN', '/tmp/project-controlled-setfacl');
    expect(() => compareAndSwapCanonicalProjectText(root, 'private.md', 'first', 'second')).toThrow('EXECUTABLE_UNTRUSTED');
    expect(fs.readFileSync(file, 'utf8')).toBe('first');
    expect(execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' })).toBe(before);
    expect(fs.readdirSync(root).filter(name => name.startsWith('.tower-write-'))).toEqual([]);
  });
  it('preserves a non-default group grant without chown during atomic replacement', () => {
    const groups = process.getgroups?.() || []; const alternate = groups.find(group => group !== process.getgid?.());
    if (alternate === undefined) return;
    const { root } = fixture(); const file = path.join(root, 'group.md'); fs.writeFileSync(file, 'first');
    fs.chownSync(file, -1, alternate); const before = fs.statSync(file);
    const chown = vi.spyOn(fs, 'fchownSync');
    compareAndSwapCanonicalProjectText(root, 'group.md', 'first', 'second');
    expect(chown).not.toHaveBeenCalled(); expect(fs.statSync(file).ino).not.toBe(before.ino);
    expect(execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' })).toContain(`group:${alternate}:`);
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
  });
  it('fails before publication when conflicting old owning and named group grants are ambiguous', () => {
    const { root } = fixture(); const file = path.join(root, 'group.md'); fs.writeFileSync(file, 'first');
    const gid = fs.statSync(file).gid;
    execFileSync('setfacl', ['-m', `g:${gid}:r--`, file]);
    const original = fs.fstatSync.bind(fs);
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options: any) => {
      const stat: any = original(fd, options);
      if (fs.readlinkSync(`/proc/self/fd/${fd}`).includes('.tower-write-')) return { ...stat, gid: BigInt(Number(stat.gid) + 1) };
      return stat;
    }) as any);
    expect(() => compareAndSwapCanonicalProjectText(root, 'group.md', 'first', 'second')).toThrow('GROUP_AMBIGUOUS');
    expect(fs.readFileSync(file, 'utf8')).toBe('first');
    expect(fs.readdirSync(root).filter(name => name.startsWith('.tower-write-'))).toEqual([]);
  });
  it('rejects a write-time race and preserves the external change', () => {
    const { root } = fixture();
    const file = path.join(root, 'race.md');
    fs.writeFileSync(file, 'first', { mode: 0o660 });
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: any) => {
      if (String(target).endsWith('/race.md')) fs.writeFileSync(file, 'external-change');
      return lstat(target, options as any);
    }) as typeof fs.lstatSync);

    expect(() => compareAndSwapCanonicalProjectText(root, 'race.md', 'first', 'assistant-change'))
      .toThrow('WORKSPACE_WRITE_STALE');
    expect(fs.readFileSync(file, 'utf8')).toBe('external-change');
    expect(fs.readdirSync(root).filter(name => name.startsWith('.tower-write-'))).toEqual([]);
  });
});


(supported && process.getuid?.() !== 0 ? it : it.skip)('uses execute-only ancestors for read, CAS and upload without allowing directory listing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-only-')); roots.push(root);
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const file = path.join(project, 'report.md'); fs.writeFileSync(file, 'first');
  fs.chmodSync(root, 0o111);
  try {
    expect(() => fs.readdirSync(root)).toThrow();
    expect(readCanonicalProjectFileBytes(project, 'report.md', 1024).toString()).toBe('first');
    compareAndSwapCanonicalProjectText(project, 'report.md', 'first', 'second');
    const { receiveWorkerProjectFileUpload } = await import('../../runtime-box/worker-project-file-upload.js');
    await receiveWorkerProjectFileUpload({ target: file, expectedBytes: 5, chunks: (async function* () { yield 'third'; })() });
    expect(readCanonicalProjectFileBytes(project, 'report.md', 1024).toString()).toBe('third');
    expect(() => fs.readdirSync(root)).toThrow();
  } finally { fs.chmodSync(root, 0o700); }
});
