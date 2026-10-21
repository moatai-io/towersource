import { linuxPathDirectoryFlags } from '../project-environment/adapters/linux-path-descriptor.js';
/**
 * Atomic Project upload publication. Uploads replace an inode, rather than editing
 * it in place: new and replacement files inherit the destination directory's
 * group/default ACL and the Worker umask, like ordinary Project file creation.
 * Replacement requests no more permission bits than the file at upload start, but
 * preserves explicit access ACLs on Linux replacements; ownership, hard links,
 * executable and special bits are not copied to the new inode.
 */
import { execFileSync } from 'node:child_process';
import { resolveProjectAclExecutables } from '../pm/new-project-acl-executable.js';
import { replacementAccessAcl } from '../project-environment/adapters/canonical-replacement-acl.js';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Linux parent traversal is descriptor-anchored; never follows ancestor links. */
async function openUploadParent(parent: string, createMissing = true): Promise<FileHandle> {
  let directory = await fs.open('/', linuxPathDirectoryFlags());
  try {
    for (const component of path.resolve(parent).split(path.sep).filter(Boolean)) {
      const nextPath = `/proc/self/fd/${directory.fd}/${component}`;
      let next: FileHandle;
      try { next = await fs.open(nextPath, linuxPathDirectoryFlags()); }
      catch (error: any) {
        if (error.code !== 'ENOENT' || !createMissing) throw error;
        try { await fs.mkdir(nextPath, { mode: 0o770 }); } catch (created: any) { if (created.code !== 'EEXIST') throw created; }
        next = await fs.open(nextPath, linuxPathDirectoryFlags());
      }
      await directory.close(); directory = next;
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}

export async function receiveWorkerProjectFileUpload(input: {
  target: string;
  expectedBytes: number;
  chunks: AsyncIterable<Uint8Array | string>;
  exclusive?: boolean;
  /** Trusted in-process admission refresh; never accepted from HTTP payloads. */
  beforePublish?: () => Promise<void>;
}): Promise<number> {
  const { expectedBytes, chunks } = input;
  let target = input.target;
  let pinnedParent: FileHandle | undefined;
  let staging: string | undefined;
  let handle: FileHandle | undefined;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_UPLOAD_BYTES) {
    throw new Error('invalid upload content length');
  }
  try {
    const originalParent = path.dirname(path.resolve(target));
    if (process.platform === 'linux') {
      pinnedParent = await openUploadParent(originalParent);
      target = `/proc/self/fd/${pinnedParent.fd}/${path.basename(target)}`;
    }
    // lstat does not follow a final symlink. Such a link is replaced by rename,
    // not written through, just as before. Its target supplies no permission policy.
    const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (input.exclusive && existing) throw Object.assign(new Error('upload target already exists'), { code: 'EEXIST' });
    const creationMode = existing?.isFile() ? 0o664 & existing.mode : 0o664;
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true });
    // mkdtemp creates a 0700 directory. A private directory (not a 0600 final
    // inode) keeps partial content inaccessible without masking inherited ACLs on
    // the published file. Keeping it under the destination also preserves setgid,
    // default ACL inheritance and same-filesystem atomic rename.
    staging = await fs.mkdtemp(path.join(parent, '.tower-worker-upload-'));
    const temp = path.join(staging, 'content');
    let received = 0;
    // Do not chmod after creation: that would override umask / ACL masks. Never
    // request execute or world-write permission, even with a permissive umask.
    handle = await fs.open(temp, 'wx', creationMode);
    for await (const chunk of chunks) {
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > expectedBytes || received > MAX_UPLOAD_BYTES) throw new Error('upload size exceeded');
      // writeFile completes the buffer; a single write may be short.
      await handle.writeFile(buffer);
    }
    if (received !== expectedBytes) throw new Error('upload content length mismatch');
    if (!input.exclusive && existing?.isFile() && process.platform === 'linux') {
      const { getfacl, setfacl } = resolveProjectAclExecutables();
      const source = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let acl: string;
      try {
        const pinned = await source.stat();
        if (!pinned.isFile() || pinned.dev !== existing.dev || pinned.ino !== existing.ino || pinned.ctimeMs !== existing.ctimeMs) throw new Error('WORKER_UPLOAD_TARGET_CHANGED');
        acl = execFileSync(getfacl, ['-cpn', '--access', '/proc/self/fd/3'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe', source.fd] });
      } finally { await source.close(); }
      const next = await fs.stat(temp);
      const preserve = replacementAccessAcl(acl, existing.gid, next.gid, existing.uid, next.uid)
        .split('\n').map(line => {
          const parts = line.split(':');
          if (parts.length === 3) parts[2] = parts[2].replace(/x/g, '-');
          if (parts[0] === 'other' && parts.length === 3) parts[2] = parts[2].replace(/w/g, '-');
          return parts.join(':');
        }).join('\n');
      execFileSync(setfacl, ['--no-mask', '--set-file=-', '/proc/self/fd/3'], { input: preserve, timeout: 5000, stdio: ['pipe', 'ignore', 'pipe', handle.fd] });
      const current = await fs.lstat(target);
      if (current.dev !== existing.dev || current.ino !== existing.ino || current.ctimeMs !== existing.ctimeMs || current.mtimeMs !== existing.mtimeMs || current.size !== existing.size) throw new Error('WORKER_UPLOAD_TARGET_CHANGED');
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await input.beforePublish?.();
    if (pinnedParent) {
      let currentParent: FileHandle;
      try { currentParent = await openUploadParent(originalParent, false); }
      catch { throw new Error('WORKER_UPLOAD_PARENT_CHANGED'); }
      try {
        const pinned = await pinnedParent.stat();
        const current = await currentParent.stat();
        if (current.dev !== pinned.dev || current.ino !== pinned.ino) throw new Error('WORKER_UPLOAD_PARENT_CHANGED');
      } finally { await currentParent.close(); }
    }
    if (input.exclusive) {
      await fs.link(temp, target);
      await fs.unlink(temp);
    } else {
      await fs.rename(temp, target);
    }
    return received;
  } finally {
    await handle?.close().catch(() => {});
    try { if (staging) await fs.rm(staging, { recursive: true, force: true }); }
    finally { await pinnedParent?.close(); }
  }
}
