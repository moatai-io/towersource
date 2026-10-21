import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { StorageSnapshot } from './project-file-storage-preflight.js';

/** Internal Linux collector. Caller must authorize and supply the registered root.
 * Directory traversal is fd-anchored; never expose this as an arbitrary-path API.
 * A scan is not an atomic snapshot: cutover still requires write exclusion/rescan.
 */
export function collectHostStorageSnapshot(input: {
  projectId: string; deploymentId: string; rootPath: string;
  maxEntries?: number; maxBytes?: number; maxDepth?: number;
}): StorageSnapshot {
  if (process.platform !== 'linux') throw new Error('STORAGE_COLLECTOR_PLATFORM_UNSUPPORTED');
  if (!input.projectId || !input.deploymentId || !path.isAbsolute(input.rootPath)) throw new Error('STORAGE_COLLECTOR_INPUT_INVALID');
  const maxEntries = input.maxEntries ?? 10_000;
  const maxBytes = input.maxBytes ?? 512 * 1024 * 1024;
  const maxDepth = input.maxDepth ?? 64;
  if (![maxEntries, maxBytes, maxDepth].every(n => Number.isSafeInteger(n) && n > 0)
    || maxEntries > 100_000 || maxBytes > 2 * 1024 ** 3 || maxDepth > 128) throw new Error('STORAGE_COLLECTOR_LIMIT_INVALID');
  const entries: StorageSnapshot['entries'] = [];
  let bytes = 0;
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  const stamp = (s: fs.BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  const buffer = Buffer.alloc(64 * 1024);
  function walk(fd: number, relative: string, depth: number) {
    if (depth > maxDepth) throw new Error('STORAGE_COLLECTOR_DEPTH_LIMIT');
    const before = fs.fstatSync(fd, { bigint: true });
    const dir = `/proc/self/fd/${fd}`;
    for (const name of fs.readdirSync(dir).sort()) {
      if (entries.length >= maxEntries) throw new Error('STORAGE_COLLECTOR_ENTRY_LIMIT');
      if (name.includes('\\')) throw new Error('STORAGE_COLLECTOR_PATH_UNSUPPORTED');
      const full = `${dir}/${name}`;
      const rel = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(full, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('STORAGE_COLLECTOR_SPECIAL_ENTRY');
      const child = fs.openSync(full, flags | (stat.isDirectory() ? fs.constants.O_DIRECTORY : fs.constants.O_NONBLOCK));
      try {
        const opened = fs.fstatSync(child, { bigint: true });
        if (stamp(stat) !== stamp(opened)) throw new Error('STORAGE_COLLECTOR_CHANGED');
        if (opened.isDirectory()) {
          entries.push({ path: rel, type: 'directory' });
          walk(child, rel, depth + 1);
        } else {
          if (!opened.isFile() || opened.nlink !== 1n) throw new Error('STORAGE_COLLECTOR_SPECIAL_ENTRY');
          if (Number(opened.size) > maxBytes - bytes) throw new Error('STORAGE_COLLECTOR_BYTE_LIMIT');
          const hash = createHash('sha256');
          let count = 0; let n: number;
          while ((n = fs.readSync(child, buffer, 0, buffer.length, null)) > 0) {
            count += n; bytes += n;
            if (bytes > maxBytes) throw new Error('STORAGE_COLLECTOR_BYTE_LIMIT');
            hash.update(buffer.subarray(0, n));
          }
          if (BigInt(count) !== opened.size || stamp(opened) !== stamp(fs.fstatSync(child, { bigint: true }))) throw new Error('STORAGE_COLLECTOR_CHANGED');
          entries.push({ path: rel, type: 'file', sizeBytes: count, sha256: hash.digest('hex') });
        }
        if (stamp(opened) !== stamp(fs.lstatSync(full, { bigint: true }))) throw new Error('STORAGE_COLLECTOR_CHANGED');
      } finally { fs.closeSync(child); }
    }
    if (stamp(before) !== stamp(fs.fstatSync(fd, { bigint: true }))) throw new Error('STORAGE_COLLECTOR_CHANGED');
  }
  // Reject symlink ancestors as well as the final root; resolve from an open / fd.
  let root = fs.openSync('/', flags | fs.constants.O_DIRECTORY);
  try {
    for (const segment of path.resolve(input.rootPath).split('/').filter(Boolean)) {
      const next = fs.openSync(`/proc/self/fd/${root}/${segment}`, flags | fs.constants.O_DIRECTORY);
      fs.closeSync(root); root = next;
    }
    walk(root, '', 0);
  } finally { fs.closeSync(root); }
  return { projectId: input.projectId, deploymentId: input.deploymentId,
    source: { kind: 'host', workerId: null }, scope: 'project-root', complete: true,
    capturedAt: Date.now(), entries };
}
