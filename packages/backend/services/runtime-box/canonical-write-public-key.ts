import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { linuxPathDirectoryFlags } from '../project-environment/adapters/linux-path-descriptor.js';

/** Shared installation-key reader. Undefined means disabled; invalid explicit
 * configuration fails closed. Never derives a public key from private material.
 * Deployment must protect configuration and key ancestors from hostile writers.
 */
export function loadCanonicalWritePublicKey(file: string | undefined): KeyObject | undefined {
 if (file === undefined) return undefined;
 let directory: number | undefined; let fd: number | undefined;
 try {
  if (!file || !path.isAbsolute(file) || path.resolve(file) !== file || file === '/') throw new Error();
  const parts = file.split('/').filter(Boolean); const name = parts.pop()!;
  directory = fs.openSync('/', linuxPathDirectoryFlags());
  for (const part of parts) {
   const next = fs.openSync(`/proc/self/fd/${directory}/${part}`, linuxPathDirectoryFlags()); fs.closeSync(directory); directory = next;
  }
  fd = fs.openSync(`/proc/self/fd/${directory}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || (stat.mode & 0o022) !== 0 || ![0,process.getuid?.()].includes(stat.uid)) throw new Error();
  const buffer = Buffer.alloc(16385); let length = 0;
  while (length < buffer.length) { const count=fs.readSync(fd,buffer,length,buffer.length-length,null); if(!count)break; length+=count; }
  const after = fs.fstatSync(fd);
  if (length>16384 || after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ctimeMs!==stat.ctimeMs) throw new Error();
  const pem = buffer.subarray(0,length).toString('utf8');
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+-----END PUBLIC KEY-----\s*$/.test(pem)) throw new Error();
  const key = createPublicKey(pem);
  if (key.type!=='public' || key.asymmetricKeyType!=='ed25519') throw new Error();
  return key;
 } catch { throw new Error('CANONICAL_WRITE_KEY_INVALID'); }
 finally { if(fd!==undefined)fs.closeSync(fd); if(directory!==undefined)fs.closeSync(directory); }
}
