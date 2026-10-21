import fs from 'node:fs';

export interface ProjectStorageGroupPolicy {
  version: 1;
  mode: 'shared-group';
  storageGid: number;
  backendUid: number;
  workerUid: number;
}
export interface ProcessStorageIdentity { uid: number; gid: number; groups: number[] }

export function parseProjectStorageGroupPolicy(raw: string): ProjectStorageGroupPolicy {
  let value: ProjectStorageGroupPolicy;
  try { value = JSON.parse(raw); } catch { throw new Error('PROJECT_STORAGE_GROUP_POLICY_INVALID'); }
  if (!value || Object.keys(value).some(k => !['version','mode','storageGid','backendUid','workerUid'].includes(k))
    || value.version !== 1 || value.mode !== 'shared-group'
    || !Number.isSafeInteger(value.storageGid) || value.storageGid <= 0
    || !Number.isSafeInteger(value.backendUid) || value.backendUid <= 0
    || !Number.isSafeInteger(value.workerUid) || value.workerUid <= 0 || value.backendUid === value.workerUid) {
    throw new Error('PROJECT_STORAGE_GROUP_POLICY_INVALID');
  }
  return value;
}

export function assertStorageGroupIdentity(policy: ProjectStorageGroupPolicy, role: 'backend'|'worker', identity: ProcessStorageIdentity): void {
  const uid = role === 'backend' ? policy.backendUid : policy.workerUid;
  if (!identity || identity.uid !== uid || !Number.isSafeInteger(identity.gid) || identity.gid <= 0
    || !Array.isArray(identity.groups) || identity.groups.some(g => !Number.isSafeInteger(g) || g <= 0)
    || !new Set([...identity.groups, identity.gid]).has(policy.storageGid)) {
    throw new Error(`PROJECT_STORAGE_${role.toUpperCase()}_GROUP_IDENTITY_MISMATCH`);
  }
}

export function readProcStorageIdentity(pid: number): ProcessStorageIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('PROJECT_STORAGE_PROCESS_PID_INVALID');
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const field = (name: string) => status.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim();
  const uid = field('Uid')?.split(/\s+/).map(Number);
  const gid = field('Gid')?.split(/\s+/).map(Number);
  const groups = field('Groups')?.split(/\s+/).filter(Boolean).map(Number);
  if (!uid || uid.length !== 4 || uid.some(x => x !== uid[0]) || !gid || gid.length !== 4 || gid.some(x => x !== gid[0]) || !groups) {
    throw new Error('PROJECT_STORAGE_PROCESS_IDENTITY_INVALID');
  }
  return { uid: uid[0], gid: gid[0], groups };
}

/** Optional installation contract. Once configured, both explicit live PIDs are mandatory. */
export function verifyConfiguredStorageGroup(env: NodeJS.ProcessEnv): 'unconfigured' | 'verified' {
  const raw = env.TOWER_PROJECT_STORAGE_GROUP_POLICY?.trim();
  if (!raw) return 'unconfigured';
  const policy = parseProjectStorageGroupPolicy(raw);
  const backendPid = Number(env.TOWER_ASSIGNMENT_BACKEND_PID);
  const workerPid = Number(env.TOWER_ASSIGNMENT_WORKER_PID);
  if (!Number.isSafeInteger(backendPid) || backendPid <= 0 || !Number.isSafeInteger(workerPid) || workerPid <= 0) {
    throw new Error('PROJECT_STORAGE_GROUP_PROCESS_PIDS_REQUIRED');
  }
  assertStorageGroupIdentity(policy, 'backend', readProcStorageIdentity(backendPid));
  assertStorageGroupIdentity(policy, 'worker', readProcStorageIdentity(workerPid));
  return 'verified';
}
