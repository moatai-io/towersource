import fs from 'node:fs';
/** Trusted service-installation configuration only; never accept from a Project request. */
export interface BackendStorageIdentity { uid: number; gid: number; groups: number[]; umask: number }
const ids = (values: number[]) => [...new Set(values)].sort((a, b) => a - b).join(',');
export function validateBackendStorageIdentity(value: BackendStorageIdentity): void {
  if (process.platform !== 'linux') throw new Error('SHARED_STORAGE_LINUX_REQUIRED');
  if (!value || !Number.isSafeInteger(value.uid) || value.uid <= 0 || !Number.isSafeInteger(value.gid) || value.gid <= 0
    || !Array.isArray(value.groups) || value.groups.some(g => !Number.isSafeInteger(g) || g <= 0)
    || !Number.isSafeInteger(value.umask) || value.umask < 0 || value.umask > 0o777) {
    throw new Error('SHARED_STORAGE_BACKEND_IDENTITY_INVALID');
  }
}
export function assertBackendStorageIdentity(value: BackendStorageIdentity): void {
  validateBackendStorageIdentity(value);
  if (process.getuid!() !== value.uid || process.geteuid!() !== value.uid || process.getgid!() !== value.gid
    || process.getegid!() !== value.gid || ids([...process.getgroups!(), value.gid]) !== ids([...value.groups, value.gid])) {
    throw new Error('SHARED_STORAGE_BACKEND_IDENTITY_MISMATCH');
  }
}
/** Drop only already-held privilege, in a dedicated child. Never elevate the parent. */
export function enterBackendStorageIdentity(value: BackendStorageIdentity): void {
  validateBackendStorageIdentity(value);
  if (process.getuid!() === 0) {
    process.setgroups!(value.groups);
    process.setgid!(value.gid);
    process.setuid!(value.uid);
  }
  assertBackendStorageIdentity(value);
  process.umask(value.umask);
}
export function sharedStorageVerificationConfig(env: NodeJS.ProcessEnv, signedGrant: boolean):
  | { status: 'unverified'; reason: string }
  | { status: 'required'; identity: BackendStorageIdentity; backendPid: number } {
  if (env.TOWER_ASSIGNMENT_VERIFY_SHARED_STORAGE !== 'true') return { status: 'unverified', reason: 'not-enabled' };
  if (signedGrant) return { status: 'unverified', reason: 'signed-grant-no-static-upload-scope' };
  let identity: BackendStorageIdentity;
  try { identity = JSON.parse(env.TOWER_ASSIGNMENT_BACKEND_IDENTITY || 'null'); } catch { throw new Error('SHARED_STORAGE_BACKEND_IDENTITY_INVALID'); }
  validateBackendStorageIdentity(identity);
  const backendPid = Number(env.TOWER_ASSIGNMENT_BACKEND_PID);
  if (!Number.isSafeInteger(backendPid) || backendPid <= 0) throw new Error('SHARED_STORAGE_BACKEND_PID_REQUIRED');
  return { status: 'required', identity, backendPid };
}

/** Cross-check the explicitly selected live Backend PID; do not infer it by name. */
export function verifyBackendProcessIdentity(pid: number, identity: BackendStorageIdentity): void {
  validateBackendStorageIdentity(identity);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('SHARED_STORAGE_BACKEND_PID_REQUIRED');
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const field = (name: string) => status.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim();
  const uid = field('Uid')?.split(/\s+/).map(Number);
  const gid = field('Gid')?.split(/\s+/).map(Number);
  const groups = field('Groups')?.split(/\s+/).filter(Boolean).map(Number);
  const mask = field('Umask');
  const caps = ['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].map(name => field(name));
  if (!uid || uid.length !== 4 || uid.some(value => value !== identity.uid)
    || !gid || gid.length !== 4 || gid.some(value => value !== identity.gid)
    || !groups || ids([...groups, identity.gid]) !== ids([...identity.groups, identity.gid])
    || !mask || parseInt(mask, 8) !== identity.umask
    || caps.some(value => !value || !/^0+$/.test(value))) {
    throw new Error('SHARED_STORAGE_BACKEND_PROCESS_IDENTITY_MISMATCH');
  }
}
