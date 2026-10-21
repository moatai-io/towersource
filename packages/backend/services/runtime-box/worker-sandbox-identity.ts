/** Minimal NSS database for the executing Worker identity; never projects host account lists. */
import os from 'node:os';

export function sandboxIdentityFiles(home: string, identity: { uid: number; gid: number; username: string }): string[] {
  if (!Number.isSafeInteger(identity.uid) || identity.uid < 0 || !Number.isSafeInteger(identity.gid) || identity.gid < 0
    || !home.startsWith('/') || /[:\r\n\0]/.test(home)) throw new Error('WORKER_SANDBOX_IDENTITY_INVALID');
  const name = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(identity.username) ? identity.username : `worker-${identity.uid}`;
  return [
    `${name}:x:${identity.uid}:${identity.gid}:Worker:${home}:/bin/sh\n`,
    `${name}:x:${identity.gid}:\n`,
    'passwd: files\ngroup: files\nshadow: files\nhosts: files dns\nnetworks: files\n',
  ];
}

export function currentSandboxIdentityFiles(home: string): string[] {
  // getuid/getgid are authoritative even if the host has no passwd entry.
  if (!process.getuid || !process.getgid) throw new Error('WORKER_SANDBOX_IDENTITY_UNSUPPORTED');
  const uid = process.getuid();
  const gid = process.getgid();
  let username = `worker-${uid}`;
  try { username = os.userInfo().username; } catch { /* Numeric service identities are valid. */ }
  return sandboxIdentityFiles(home, { uid, gid, username });
}
