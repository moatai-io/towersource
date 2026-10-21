import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { receiveWorkerProjectFileUpload } from './worker-project-file-upload.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-upload-permissions-'));
  roots.push(root);
  return { root, target: path.join(root, 'upload.txt') };
}

async function* content(...chunks: string[]) { yield* chunks; }
const upload = (target: string, text = 'complete') => receiveWorkerProjectFileUpload({
  target, expectedBytes: Buffer.byteLength(text), chunks: content(text),
});
const permissionBits = async (file: string) => (await fs.stat(file)).mode & 0o777;
const helperUrl = pathToFileURL(path.join(process.cwd(), 'packages/backend/services/runtime-box/worker-project-file-upload.ts')).href;

// umask is process-global: exercise alternate service umasks in isolated children,
// never change Vitest's process or interfere with concurrently running tests.
function uploadWithUmask(target: string, umask: number) {
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { receiveWorkerProjectFileUpload } from ${JSON.stringify(helperUrl)};
    process.umask(Number(process.argv[2]));
    await receiveWorkerProjectFileUpload({ target: process.argv[1], expectedBytes: 2,
      chunks: (async function* () { yield Buffer.from('ok'); })() });
  `, target, String(umask)], { timeout: 15_000 });
}

const hasAcl = process.platform === 'linux'
  && spawnSync('setfacl', ['--version']).status === 0
  && spawnSync('getfacl', ['--version']).status === 0;

function setDefaultAcl(root: string, acl = 'd:u::rwx,d:g::rwx,d:m::rwx,d:o::---') {
  execFileSync('setfacl', ['-m', acl, root]);
}

function aclOf(file: string) {
  return execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' });
}

describe('Worker Project upload publication', () => {
  it.each([[0o002, 0o664], [0o022, 0o644], [0o077, 0o600], [0o000, 0o664]])(
    'honors umask %s without execute or world-write (mode %s)', async (umask, mode) => {
      const { root, target } = await fixture();
      uploadWithUmask(target, umask);
      expect(await fs.readFile(target, 'utf8')).toBe('ok');
      expect(await permissionBits(target)).toBe(mode);
      expect(await fs.readdir(root)).toEqual(['upload.txt']);
    },
  );

  it('hides streamed bytes behind a 0700 directory and publishes only complete content', async () => {
    const { root, target } = await fixture();
    await fs.writeFile(target, 'original', { mode: 0o664 });
    const bytes = async function* () {
      yield Buffer.from('first');
      const stages = (await fs.readdir(root)).filter(name => name.startsWith('.tower-worker-upload-'));
      expect(stages).toHaveLength(1);
      const staging = path.join(root, stages[0]);
      expect(await permissionBits(staging)).toBe(0o700);
      expect(await fs.readFile(path.join(staging, 'content'), 'utf8')).toBe('first');
      expect(await fs.readFile(target, 'utf8')).toBe('original');
      yield Buffer.from('-last');
    };
    expect(await receiveWorkerProjectFileUpload({ target, expectedBytes: 10, chunks: bytes() })).toBe(10);
    expect(await fs.readFile(target, 'utf8')).toBe('first-last');
    expect(await fs.readdir(root)).toEqual(['upload.txt']);
  });

  it.each([0o600, 0o640, 0o660, 0o664, 0o444, 0o4755, 0o666])(
    'bounds replacement permissions by the previous mode %s, removing special/execute/world-write bits', async mode => {
      const { root, target } = await fixture();
      await fs.writeFile(target, 'original');
      await fs.chmod(target, mode);
      const hardLink = path.join(root, 'old-inode');
      await fs.link(target, hardLink);
      uploadWithUmask(target, 0);
      expect((await fs.stat(target)).mode & 0o7777).toBe(mode & 0o664);
      expect(await fs.readFile(target, 'utf8')).toBe('ok');
      expect(await fs.readFile(hardLink, 'utf8')).toBe('original');
    },
  );

  it.each([
    { expected: 3, text: 'long', message: 'upload size exceeded' },
    { expected: 8, text: 'short', message: 'upload content length mismatch' },
  ])('preserves the old file and cleans staging after $message', async ({ expected, text, message }) => {
    const { root, target } = await fixture();
    await fs.writeFile(target, 'original');
    await expect(receiveWorkerProjectFileUpload({ target, expectedBytes: expected, chunks: content(text) })).rejects.toThrow(message);
    expect(await fs.readFile(target, 'utf8')).toBe('original');
    expect(await fs.readdir(root)).toEqual(['upload.txt']);
  });

  it('cleans staging after an interrupted stream without publishing a new file', async () => {
    const { root, target } = await fixture();
    const aborted = async function* () { yield 'part'; throw new Error('aborted'); };
    await expect(receiveWorkerProjectFileUpload({ target, expectedBytes: 8, chunks: aborted() })).rejects.toThrow('aborted');
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('cleans staging when atomic publication fails', async () => {
    const { root, target } = await fixture();
    await fs.mkdir(target);
    await expect(upload(target)).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual(['upload.txt']);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it.each([-1, NaN, 0.5, 200 * 1024 * 1024 + 1])('rejects invalid size %s before creating storage', async expectedBytes => {
    const { root, target } = await fixture();
    await expect(receiveWorkerProjectFileUpload({ target, expectedBytes, chunks: content() })).rejects.toThrow('invalid upload content length');
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('publishes exclusively without overwriting an existing target', async () => {
    const { target } = await fixture();
    await fs.writeFile(target, 'original');
    await expect(receiveWorkerProjectFileUpload({
      target, expectedBytes: 3, chunks: content('new'), exclusive: true,
    })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(target, 'utf8')).toBe('original');
  });

  it('allows only one concurrent exclusive publication to a new target', async () => {
    const { root, target } = await fixture();
    const results = await Promise.allSettled([
      receiveWorkerProjectFileUpload({ target, expectedBytes: 5, chunks: content('first'), exclusive: true }),
      receiveWorkerProjectFileUpload({ target, expectedBytes: 6, chunks: content('second'), exclusive: true }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(await fs.readFile(target, 'utf8'));
    expect(await fs.readdir(root)).toEqual(['upload.txt']);
  });

  it('publishes an empty upload', async () => {
    const { target } = await fixture();
    expect(await upload(target, '')).toBe(0);
    expect((await fs.stat(target)).size).toBe(0);
  });

  it('uses independent staging for concurrent uploads to the same path', async () => {
    const { root, target } = await fixture();
    await Promise.all([upload(target, 'first'), upload(target, 'second')]);
    expect(['first', 'second']).toContain(await fs.readFile(target, 'utf8'));
    expect(await fs.readdir(root)).toEqual(['upload.txt']);
  });

  it('replaces a final symlink without modifying its target', async () => {
    const { root, target } = await fixture();
    const linked = path.join(root, 'linked');
    await fs.writeFile(linked, 'original', { mode: 0o600 });
    await fs.symlink(linked, target);
    await upload(target);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(linked, 'utf8')).toBe('original');
  });
});

describe.skipIf(!hasAcl)('Linux Project default ACL and group inheritance', () => {
  it('inherits setgid and default ACL across private staging, even under umask 077', async () => {
    const { root, target } = await fixture();
    // Use a supplementary group when available to distinguish real inheritance
    // from the Worker's primary group. No elevated identity or host ACL changes.
    const gid = process.getgroups().find(group => group !== process.getgid()) ?? process.getgid();
    await fs.chown(root, process.getuid(), gid);
    await fs.chmod(root, 0o2770);
    setDefaultAcl(root);
    uploadWithUmask(target, 0o077);
    expect(await permissionBits(target)).toBe(0o660);
    expect((await fs.stat(target)).gid).toBe(gid);
    expect(aclOf(target)).toContain('group::rwx\t#effective:rw-');
    expect(aclOf(target)).toContain('mask::rw-');
    expect(aclOf(target)).toContain('other::---');
  });

  it('retains named ACL entries without overriding their effective mask', async () => {
    const { root, target } = await fixture();
    setDefaultAcl(root, 'd:u::rwx,d:u:65534:r--,d:g::rwx,d:m::r-x,d:o::---');
    uploadWithUmask(target, 0o002);
    expect(await permissionBits(target)).toBe(0o640);
    expect(aclOf(target)).toContain('user:65534:r--');
    expect(aclOf(target)).toContain('mask::r--');
    expect(aclOf(target)).toContain('group::rwx\t#effective:r--');
  });

  it('keeps inherited named ACL entries ineffective while content is staged', async () => {
    const { root, target } = await fixture();
    setDefaultAcl(root, 'd:u::rwx,d:u:65534:rw-,d:g::rwx,d:m::rwx,d:o::r-x');
    const chunks = async function* () {
      yield 'part';
      const stages = (await fs.readdir(root)).filter(name => name.startsWith('.tower-worker-upload-'));
      const staging = path.join(root, stages[0]);
      expect(await permissionBits(staging)).toBe(0o700);
      expect(aclOf(staging)).toContain('user:65534:rw-\t#effective:---');
      expect(aclOf(staging)).toContain('mask::---');
      expect(aclOf(staging)).toContain('other::---');
      yield 'done';
    };
    await receiveWorkerProjectFileUpload({ target, expectedBytes: 8, chunks: chunks() });
    expect(aclOf(target)).toContain('user:65534:rw-');
    expect(aclOf(target)).toContain('mask::rw-');
  });

  it('does not let an inherited ACL broaden a private replacement', async () => {
    const { root, target } = await fixture();
    await fs.writeFile(target, 'private', { mode: 0o600 });
    setDefaultAcl(root);
    uploadWithUmask(target, 0o002);
    expect(await permissionBits(target)).toBe(0o600);
    // A simple private source has no extended mask or peer grant to copy.
    const acl = aclOf(target);
    expect(acl).toContain('group::---');
    expect(acl).not.toContain('user:65534:rw-');
  });

  it('inherits default ACL through newly created destination directories', async () => {
    const { root } = await fixture();
    await fs.chmod(root, 0o2770);
    setDefaultAcl(root);
    const target = path.join(root, 'nested', 'subdir', 'file.txt');
    uploadWithUmask(target, 0o077);
    expect(await permissionBits(target)).toBe(0o660);
    expect(await permissionBits(path.dirname(target))).toBe(0o770);
    expect((await fs.stat(path.dirname(target))).mode & 0o2000).toBe(0o2000);
  });
});


it('preserves a named-user grant not present in the destination defaults', async () => {
  if (process.platform !== 'linux' || spawnSync('setfacl', ['--version']).status !== 0) return;
  const { root, target } = await fixture();
  await fs.writeFile(target, 'original', { mode: 0o600 });
  execFileSync('setfacl', ['-m', 'u:65534:rw-,m::rw-', target]);
  const result = await upload(target, 'replacement');
  expect(result).toBe(11);
  expect(execFileSync('getfacl', ['-cpn', target], { encoding: 'utf8' })).toContain('user:65534:rw-');
  expect(await fs.readdir(root)).toEqual(['upload.txt']);
});


it('aborts replacement when the target changes during upload and cleans staging', async () => {
  if (process.platform !== 'linux' || spawnSync('setfacl', ['--version']).status !== 0) return;
  const { root, target } = await fixture();
  await fs.writeFile(target, 'original');
  async function* changedContent() {
    yield 'new';
    await fs.writeFile(target, 'concurrent-content');
  }
  await expect(receiveWorkerProjectFileUpload({ target, expectedBytes: 3, chunks: changedContent() })).rejects.toThrow('WORKER_UPLOAD_TARGET_CHANGED');
  expect(await fs.readFile(target, 'utf8')).toBe('concurrent-content');
  expect(await fs.readdir(root)).toEqual(['upload.txt']);
});

it('rejects symlink ancestors without writing outside the requested directory', async () => {
  if (process.platform !== 'linux') return;
  const { root } = await fixture();
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'link'));
  await expect(upload(path.join(root, 'link', 'report.md'))).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
});
it('rejects publication when the original parent path is swapped and cleans pinned staging', async () => {
  if (process.platform !== 'linux') return;
  const { root } = await fixture();
  const parent = path.join(root, 'parent'); const moved = path.join(root, 'moved');
  await fs.mkdir(parent); await fs.writeFile(path.join(parent, 'report.md'), 'old');
  async function* swap() {
    yield 'new';
    await fs.rename(parent, moved); await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, 'report.md'), 'unrelated');
  }
  await expect(receiveWorkerProjectFileUpload({ target: path.join(parent, 'report.md'), expectedBytes: 3, chunks: swap() })).rejects.toThrow('WORKER_UPLOAD_PARENT_CHANGED');
  expect(await fs.readFile(path.join(parent, 'report.md'), 'utf8')).toBe('unrelated');
  expect(await fs.readFile(path.join(moved, 'report.md'), 'utf8')).toBe('old');
  expect(await fs.readdir(moved)).toEqual(['report.md']);
});

it('does not recreate a deleted parent pathname at publication', async () => {
  if (process.platform !== 'linux') return;
  const { root } = await fixture();
  const parent = path.join(root, 'parent'); const moved = path.join(root, 'moved');
  await fs.mkdir(parent);
  async function* movedParent() { yield 'new'; await fs.rename(parent, moved); }
  await expect(receiveWorkerProjectFileUpload({ target: path.join(parent, 'new.md'), expectedBytes: 3, chunks: movedParent() })).rejects.toThrow('WORKER_UPLOAD_PARENT_CHANGED');
  await expect(fs.stat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(moved)).toEqual([]);
});


function publicationBarrier() {
  let release!: () => void;
  let reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, async wait() { reached(); await resume; } };
}

it('deterministically rejects a parent swap after staging without losing either reader version', async () => {
  if (process.platform !== 'linux') return;
  const { root } = await fixture();
  const parent = path.join(root, '.drafts', '중첩');
  const moved = path.join(root, 'moved');
  await fs.mkdir(parent, { recursive: true });
  const target = path.join(parent, '계약서.md');
  await fs.writeFile(target, 'original');
  const barrier = publicationBarrier();
  async function* pausedUpload() { yield 'complete-new'; await barrier.wait(); }
  const pending = receiveWorkerProjectFileUpload({ target, expectedBytes: 12, chunks: pausedUpload() });
  // Attach rejection before resuming: no timer or unhandled-rejection race.
  const rejected = expect(pending).rejects.toThrow('WORKER_UPLOAD_PARENT_CHANGED');
  await barrier.ready;
  expect(await fs.readFile(target, 'utf8')).toBe('original');
  await fs.rename(parent, moved); await fs.mkdir(parent);
  await fs.writeFile(target, 'unrelated');
  barrier.release(); await rejected;
  expect(await fs.readFile(target, 'utf8')).toBe('unrelated');
  expect(await fs.readFile(path.join(moved, '계약서.md'), 'utf8')).toBe('original');
  expect(await fs.readdir(moved)).toEqual(['계약서.md']);
});

// Known gap, not a passing safety guarantee: the final pathname check and rename
// are not an atomic snapshot CAS. it.fails makes a future fix require updating
// this characterization instead of silently retaining an obsolete expected gap.
it.fails('preserves a concurrent target change occurring after the final check before rename', async () => {
  if (process.platform !== 'linux') throw new Error('Linux-only known-gap characterization');
  const { root, target } = await fixture();
  await fs.writeFile(target, 'original');
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, destination) => {
    await fs.writeFile(target, 'concurrent');
    await rename(source, destination);
  });
  await upload(target, 'replacement');
  // Current implementation overwrites this change. Keep that limitation visible.
  expect(await fs.readFile(target, 'utf8')).toBe('concurrent');
  expect(await fs.readdir(root)).toEqual(['upload.txt']);
});

it('awaits publication authorization after staging and preserves the old file on revocation', async () => {
  const { root, target } = await fixture(); await fs.writeFile(target, 'original');
  const barrier = publicationBarrier(); let allowed = true;
  const pending = receiveWorkerProjectFileUpload({ target, expectedBytes: 3, chunks: content('new'), beforePublish: async () => { await barrier.wait(); if (!allowed) throw new Error('ACCESS_REVOKED'); } });
  const rejected = expect(pending).rejects.toThrow('ACCESS_REVOKED');
  await barrier.ready; expect(await fs.readFile(target, 'utf8')).toBe('original');
  allowed = false; barrier.release(); await rejected;
  expect(await fs.readFile(target, 'utf8')).toBe('original');
  expect(await fs.readdir(root)).toEqual(['upload.txt']);
});
