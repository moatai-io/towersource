import fs from 'node:fs';
import path from 'node:path';
import { linuxPathDirectoryFlags } from '../project-environment/adapters/linux-path-descriptor.js';

/** Install a dedicated 0700 runtime directory outside writable Project roots.
 * Same-UID hostile native jobs could tamper with it; identity isolation remains
 * a prerequisite. No automatic deletion: expired records may only be removed
 * by an approved maintenance policy after their grants can no longer verify.
 * Root descriptors and O_EXCL avoid path replacement and concurrent replay.
 */
export function createCanonicalWriteReplayStore(root: string): (nonce: string, expiresAtMs: number) => Promise<boolean> {
 if (!path.isAbsolute(root) || path.resolve(root) !== root || root === '/') throw new Error('WRITE_REPLAY_ROOT_INVALID');
 const openRoot = () => {
  let fd = fs.openSync('/', linuxPathDirectoryFlags());
  try {
   for (const component of root.split('/').filter(Boolean)) {
    const next = fs.openSync(`/proc/self/fd/${fd}/${component}`, linuxPathDirectoryFlags()); fs.closeSync(fd); fd = next;
   }
   return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
 };
 const verify = (fd: number) => {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== 0o700n) throw new Error('WRITE_REPLAY_ROOT_UNTRUSTED');
  return stat;
 };
 const initialFd = openRoot();
 let identity: fs.BigIntStats;
 try { identity = verify(initialFd); } finally { fs.closeSync(initialFd); }
 return async (nonce, expiresAtMs) => {
  const now = Date.now();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
   || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + 60_000) throw new Error('WRITE_REPLAY_CLAIM_INVALID');
  const rootFd = openRoot();
  try {
   const current = verify(rootFd);
   if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('WRITE_REPLAY_ROOT_CHANGED');
   let receipt: number;
   try { receipt = fs.openSync(`/proc/self/fd/${rootFd}/${nonce.toLowerCase()}`, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
   catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
   try { fs.fsyncSync(receipt); } finally { fs.closeSync(receipt); }
   // O_PATH descriptors cannot fsync; open the pinned directory for durability.
   const syncFd = fs.openSync(`/proc/self/fd/${rootFd}/.`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
   try { fs.fsyncSync(syncFd); } finally { fs.closeSync(syncFd); }
   return true;
  } finally { fs.closeSync(rootFd); }
 };
}
