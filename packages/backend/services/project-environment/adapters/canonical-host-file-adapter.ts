import { resolveInternalReadAlias } from './internal-read-alias.js';
import { linuxPathDirectoryFlags } from './linux-path-descriptor.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveProjectAclExecutables } from '../../pm/new-project-acl-executable.js';
import { replacementAccessAcl } from './canonical-replacement-acl.js';

export const MAX_CANONICAL_WORKSPACE_READ_BYTES = 8 * 1024 * 1024;
export const MAX_CANONICAL_WORKSPACE_TEXT_BYTES = 1024 * 1024;
const MAX_CANONICAL_FILE_IO_BYTES = 200 * 1024 * 1024;

/** Internal aliases resolve to protected-path-checked candidates; fd-anchored final
 * opens still reject symlinks, hard links and special files. Mutations stay strict. */
export function readCanonicalProjectFileBytes(root: string, relativePath: string, maxBytes: number): Buffer {
  return readCanonicalProjectBytes(root, relativePath, maxBytes, false);
}

export function readCanonicalProjectFileProbe(root: string, relativePath: string, maxBytes: number): Buffer {
  return readCanonicalProjectBytes(root, relativePath, maxBytes, true);
}

function readCanonicalProjectBytes(root: string, relativePath: string, maxBytes: number, prefix: boolean): Buffer {
  if (process.platform !== 'linux') throw new Error('WORKSPACE_HOST_PLATFORM_UNSUPPORTED');
  if (!path.isAbsolute(root) || path.resolve(root) === '/' || !relativePath || relativePath === '.'
    || /[\\\x00-\x1f]/.test(relativePath) || relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('WORKSPACE_READ_PATH_INVALID');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CANONICAL_FILE_IO_BYTES) throw new Error('WORKSPACE_READ_LIMIT_INVALID');
  relativePath = resolveInternalReadAlias(root, relativePath);
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  let directory = fs.openSync('/', linuxPathDirectoryFlags());
  try {
    const parts = [...path.resolve(root).split('/').filter(Boolean), ...relativePath.split('/')];
    const name = parts.pop()!;
    for (const part of parts) {
      const next = fs.openSync(`/proc/self/fd/${directory}/${part}`, linuxPathDirectoryFlags());
      fs.closeSync(directory);
      directory = next;
    }
    const file = fs.openSync(`/proc/self/fd/${directory}/${name}`, flags | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(file, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw new Error('WORKSPACE_READ_SPECIAL_FILE');
      if (!prefix && before.size > BigInt(maxBytes)) throw new Error('WORKSPACE_READ_SIZE_LIMIT');
      const expected = prefix ? Number(before.size < BigInt(maxBytes) ? before.size : BigInt(maxBytes)) : Number(before.size);
      const bytes = Buffer.alloc(expected + (prefix ? 0 : 1));
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(file, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      const after = fs.fstatSync(file, { bigint: true });
      if (length !== expected || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('WORKSPACE_READ_CHANGED');
      return bytes.subarray(0, length);
    } finally {
      fs.closeSync(file);
    }
  } finally {
    fs.closeSync(directory);
  }
}

function canonicalHostTarget(root: string, relativePath: string): { resolvedRoot: string; target: string } {
  if (!path.isAbsolute(root) || path.resolve(root) === '/' || !relativePath || relativePath === '.'
    || /[\\\x00-\x1f]/.test(relativePath) || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('WORKSPACE_WRITE_PATH_INVALID');
  }
  const resolvedRoot = fs.realpathSync.native(root);
  const target = path.resolve(resolvedRoot, ...relativePath.split('/'));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('WORKSPACE_WRITE_PATH_INVALID');
  return { resolvedRoot, target };
}

function assertCanonicalAncestors(root: string, target: string, createMissing: boolean): void {
  const relativeParent = path.relative(root, path.dirname(target));
  let current = root;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('WORKSPACE_WRITE_UNSAFE_ANCESTOR');
    } catch (error: any) {
      if (error?.code !== 'ENOENT' || !createMissing) throw error;
      // Request the group-class write bit so an inherited named-peer ACL is
      // not masked by 0755. No ACL means the normal process umask still applies.
      fs.mkdirSync(current, { mode: 0o770 });
    }
  }
}

export function writeCanonicalProjectText(root: string, relativePath: string, content: string, exclusive = false): void {
  canonicalHostTarget(root, relativePath);
  publishCanonicalText(root, relativePath, content, { exclusive });
}

export function createCanonicalProjectDirectory(root: string, relativePath: string, exclusive = false): void {
  const { resolvedRoot, target } = canonicalHostTarget(root, relativePath);
  assertCanonicalAncestors(resolvedRoot, target, true);
  if (exclusive) fs.mkdirSync(target);
  else fs.mkdirSync(target, { recursive: true });
}

export function deleteCanonicalProjectEntry(root: string, relativePath: string): void {
  const { resolvedRoot, target } = canonicalHostTarget(root, relativePath);
  assertCanonicalAncestors(resolvedRoot, target, false);
  const stat = fs.lstatSync(target);
  // Unlink only the final entry, including dangling links. Never follow its target.
  // Ancestor links remain forbidden by assertCanonicalAncestors above.
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('WORKSPACE_DELETE_UNSAFE_TARGET');
  fs.rmSync(target, { recursive: stat.isDirectory(), force: false });
}

export function renameCanonicalProjectEntry(root: string, sourceRelativePath: string, targetRelativePath: string): void {
  const source = canonicalHostTarget(root, sourceRelativePath);
  const target = canonicalHostTarget(root, targetRelativePath);
  assertCanonicalAncestors(source.resolvedRoot, source.target, false);
  assertCanonicalAncestors(target.resolvedRoot, target.target, true);
  const sourceStat = fs.lstatSync(source.target);
  if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) throw new Error('WORKSPACE_RENAME_UNSAFE_SOURCE');
  try {
    fs.lstatSync(target.target);
    const error = new Error('EEXIST') as NodeJS.ErrnoException;
    error.code = 'EEXIST';
    throw error;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fs.renameSync(source.target, target.target);
}

function assertCanonicalCopyTreeSafe(source: string): void {
  const stat = fs.lstatSync(source, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n)) {
    throw new Error('WORKSPACE_COPY_UNSAFE_SOURCE');
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(source)) assertCanonicalCopyTreeSafe(path.join(source, entry));
}

export function copyCanonicalProjectEntry(root: string, sourceRelativePath: string, targetDirectoryRelativePath: string): string {
  const source = canonicalHostTarget(root, sourceRelativePath);
  const targetDirectory = targetDirectoryRelativePath === '.'
    ? { resolvedRoot: source.resolvedRoot, target: source.resolvedRoot }
    : canonicalHostTarget(root, targetDirectoryRelativePath);
  assertCanonicalAncestors(source.resolvedRoot, source.target, false);
  assertCanonicalAncestors(targetDirectory.resolvedRoot, path.join(targetDirectory.target, 'placeholder'), false);
  assertCanonicalCopyTreeSafe(source.target);
  const sourceStat = fs.lstatSync(source.target);
  const targetStat = fs.lstatSync(targetDirectory.target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('WORKSPACE_COPY_UNSAFE_TARGET');
  if (sourceStat.isDirectory() && (targetDirectory.target === source.target || targetDirectory.target.startsWith(`${source.target}${path.sep}`))) {
    throw new Error('Cannot copy a folder into itself or its subfolder');
  }
  const extension = path.extname(source.target);
  const stem = path.basename(source.target, extension);
  for (let index = 0; index <= 1000; index++) {
    const name = index === 0 ? path.basename(source.target) : `${stem}${index === 1 ? ' copy' : ` copy ${index}`}${extension}`;
    const target = path.join(targetDirectory.target, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.cpSync(source.target, target, { recursive: true, errorOnExist: true, force: false });
      return path.relative(source.resolvedRoot, target).split(path.sep).join('/');
    } catch (error: any) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ERR_FS_CP_EEXIST') throw error;
    }
  }
  throw new Error(`Could not find available copy name for ${path.basename(source.target)}`);
}

/** Existing UTF-8 file CAS replacement with fd-anchored containment and atomic publication. */
export function compareAndSwapCanonicalProjectText(root: string, relativePath: string, expectedContent: string, content: string): void {
  const current = readCanonicalProjectFileBytes(root, relativePath, MAX_CANONICAL_WORKSPACE_TEXT_BYTES);
  if (!current.equals(Buffer.from(expectedContent))) throw new Error('WORKSPACE_WRITE_STALE');
  publishCanonicalText(root, relativePath, content, { expected: current, exclusive: false });
}

/** Shared staged publication. CAS remains bounded; normal replacement need not
 * read the old payload. Rename is atomic, not a lock against arbitrary writers. */
function publishCanonicalText(root: string, relativePath: string, content: string, options: { expected?: Buffer; exclusive: boolean }): void {
  let directory = fs.openSync('/', linuxPathDirectoryFlags());
  let temporary: string | undefined;
  try {
    const parts = [...path.resolve(root).split('/').filter(Boolean), ...relativePath.split('/')];
    const name = parts.pop()!;
    for (const [index, part] of parts.entries()) {
      const entry = `/proc/self/fd/${directory}/${part}`;
      if (!options.expected && index >= path.resolve(root).split('/').filter(Boolean).length) {
        try { fs.mkdirSync(entry, { mode: 0o770 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const next = fs.openSync(entry, linuxPathDirectoryFlags());
      fs.closeSync(directory);
      directory = next;
    }
    const target = `/proc/self/fd/${directory}/${name}`;
    let file: number;
    try { file = fs.openSync(target, (options.expected === undefined ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.expected) throw error;
      temporary = `/proc/self/fd/${directory}/.tower-write-${randomUUID()}`;
      const stage = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o660);
      try { fs.writeFileSync(stage, content, 'utf8'); fs.fsyncSync(stage); } finally { fs.closeSync(stage); }
      // Atomic exclusive publication: a concurrent creator is never overwritten.
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary); temporary = undefined;
      return;
    }
    try {
      if (options.exclusive) throw Object.assign(new Error('WORKSPACE_WRITE_ALREADY_EXISTS'), { code: 'EEXIST' });
      const stat = fs.fstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || (options.expected !== undefined && stat.size > BigInt(MAX_CANONICAL_WORKSPACE_TEXT_BYTES))) throw new Error('WORKSPACE_WRITE_UNSAFE_TARGET');
      if (options.expected !== undefined) {
        const actual = Buffer.alloc(Number(stat.size) + 1);
        let length = 0;
        while (length < actual.length) {
          const count = fs.readSync(file, actual, length, actual.length - length, null);
          if (!count) break;
          length += count;
        }
        if (!actual.subarray(0, length).equals(options.expected)) throw new Error('WORKSPACE_WRITE_STALE');
      }
      // Copy the existing access ACL, not the parent default: replacement must neither
      // revoke approved named-user grants nor widen deliberately private files.
      const { setfacl, getfacl } = resolveProjectAclExecutables();
      const acl = execFileSync(getfacl, ['-cpn', '--access', '/proc/self/fd/3'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', file], maxBuffer: 64 * 1024,
      });
      temporary = `/proc/self/fd/${directory}/.tower-write-${randomUUID()}`;
      const stage = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        fs.writeFileSync(stage, content, 'utf8');
        const stageIdentity = fs.fstatSync(stage, { bigint: true });
        const stageGroup = Number(stageIdentity.gid);
        const preservedAcl = replacementAccessAcl(acl, Number(stat.gid), stageGroup, Number(stat.uid), Number(stageIdentity.uid));
        fs.fchmodSync(stage, Number(stat.mode & 0o777n));
        execFileSync(setfacl, ['--no-mask', '--set-file=-', '/proc/self/fd/3'], {
          input: preservedAcl, stdio: ['pipe', 'pipe', 'pipe', stage], maxBuffer: 64 * 1024,
        });
        fs.fsyncSync(stage);
      } finally {
        fs.closeSync(stage);
      }
      const latest = fs.lstatSync(target, { bigint: true });
      if (latest.dev !== stat.dev || latest.ino !== stat.ino || latest.size !== stat.size || latest.mtimeNs !== stat.mtimeNs || latest.ctimeNs !== stat.ctimeNs) throw new Error('WORKSPACE_WRITE_STALE');
      fs.renameSync(temporary, target);
      temporary = undefined;
    } finally {
      fs.closeSync(file);
    }
  } finally {
    try {
      if (temporary) fs.unlinkSync(temporary);
    } finally {
      fs.closeSync(directory);
    }
  }
}
