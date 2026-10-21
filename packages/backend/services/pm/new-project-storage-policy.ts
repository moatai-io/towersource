import { freshProjectPeerAcl } from './project-peer-acl.js';
/** Derived installation contract for new shared-local Project roots only.
 * No app user membership, Worker binding, existing-tree repair or privilege escalation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readTrustedNewProjectPolicyFile } from './new-project-storage-policy-file.js';
import { resolveNewProjectAclExecutable } from './new-project-acl-executable.js';

export interface NewProjectStoragePolicy {
  version: 1;
  mode: 'shared-local';
  backendUid: number;
  workerUid: number;
  projectParents: string[];
}

function parsePolicy(raw: string): NewProjectStoragePolicy {
  let value: NewProjectStoragePolicy;
  try { value = JSON.parse(raw); } catch { throw new Error('NEW_PROJECT_STORAGE_POLICY_INVALID'); }
  if (!value || Object.keys(value).some(key => !['version', 'mode', 'backendUid', 'workerUid', 'projectParents'].includes(key))
    || value.version !== 1 || value.mode !== 'shared-local'
    || !Number.isSafeInteger(value.backendUid) || value.backendUid <= 0
    || !Number.isSafeInteger(value.workerUid) || value.workerUid <= 0 || value.workerUid === value.backendUid
    || !Array.isArray(value.projectParents) || !value.projectParents.length
    || value.projectParents.some(p => typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p || p === '/')) {
    throw new Error('NEW_PROJECT_STORAGE_POLICY_INVALID');
  }
  return { version: 1, mode: 'shared-local', backendUid: value.backendUid, workerUid: value.workerUid,
    projectParents: [...new Set(value.projectParents)].sort() };
}

function trustedRootFile(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.nlink !== 1) {
    throw new Error('NEW_PROJECT_STORAGE_INSTALLATION_UNTRUSTED');
  }
  return fs.readFileSync(file, 'utf8');
}

function derivedInstallationPolicy(env: NodeJS.ProcessEnv): NewProjectStoragePolicy | undefined {
  if (env.NODE_ENV !== 'production') return undefined;
  const workerId = env.TOWER_PRIMARY_WORKER_ID?.trim();
  if (!workerId || !/^[A-Za-z0-9._-]{1,120}$/.test(workerId)) throw new Error('NEW_PROJECT_STORAGE_WORKER_IDENTITY_REQUIRED');
  const unitRoot = env.TOWER_SYSTEMD_UNIT_ROOT?.trim() || '/etc/systemd/system';
  if (!path.isAbsolute(unitRoot) || path.resolve(unitRoot) !== unitRoot) throw new Error('NEW_PROJECT_STORAGE_INSTALLATION_UNTRUSTED');
  const unit = trustedRootFile(path.join(unitRoot, `tower-workbench-worker-${workerId}.service`));
  const users = [...unit.matchAll(/^User=([^\s#]+)$/gm)].map(match => match[1]);
  if (users.length !== 1 || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(users[0])) throw new Error('NEW_PROJECT_STORAGE_WORKER_IDENTITY_REQUIRED');
  const passwdFile = env.TOWER_PASSWD_FILE?.trim() || '/etc/passwd';
  const passwd = trustedRootFile(passwdFile);
  const rows = passwd.split('\n').filter(Boolean).map(line => line.split(':'));
  const matches = rows.filter(row => row[0] === users[0] && /^\d+$/.test(row[2] ?? ''));
  if (matches.length !== 1) throw new Error('NEW_PROJECT_STORAGE_WORKER_IDENTITY_REQUIRED');
  const workerUid = Number(matches[0][2]);
  const backendUid = process.getuid?.();
  if (!Number.isSafeInteger(backendUid) || !backendUid || !Number.isSafeInteger(workerUid) || workerUid <= 0 || workerUid === backendUid) {
    throw new Error('NEW_PROJECT_STORAGE_BACKEND_IDENTITY_MISMATCH');
  }
  const workspaceRoot = path.resolve(env.WORKSPACE_ROOT || path.join(env.HOME || '/nonexistent', 'workspace'));
  const projectParent = path.join(workspaceRoot, 'projects');
  const parent = fs.realpathSync(projectParent);
  if (parent !== projectParent || fs.lstatSync(parent).isSymbolicLink() || !fs.statSync(parent).isDirectory()) {
    throw new Error('NEW_PROJECT_STORAGE_ROOT_NOT_ALLOWED');
  }
  return { version: 1, mode: 'shared-local', backendUid, workerUid, projectParents: [parent] };
}

/**
 * Production derives the contract from the live installation. Explicit env/file
 * inputs remain as a compatibility seam for tests and staged legacy migration.
 */
export function readNewProjectStoragePolicy(env: NodeJS.ProcessEnv = process.env): NewProjectStoragePolicy | undefined {
  const rawEnv = env.TOWER_NEW_PROJECT_STORAGE_POLICY;
  const fromEnv = rawEnv?.trim() ? parsePolicy(rawEnv) : undefined;
  const configuredFile = env.TOWER_NEW_PROJECT_STORAGE_POLICY_FILE;
  if (configuredFile !== undefined && !configuredFile.trim()) throw new Error('NEW_PROJECT_STORAGE_POLICY_FILE_UNTRUSTED');
  const rawFile = configuredFile === undefined ? undefined : readTrustedNewProjectPolicyFile(configuredFile);
  const fromFile = rawFile === undefined ? undefined : parsePolicy(rawFile);
  if (fromFile && fromEnv && JSON.stringify(fromFile) !== JSON.stringify(fromEnv)) throw new Error('NEW_PROJECT_STORAGE_POLICY_CONFLICT');
  return fromFile ?? fromEnv ?? derivedInstallationPolicy(env);
}

function applyAcl(root: string, backendUid: number, workerUid: number, workerPermissions: 'rwx' | 'r-x', env?: NodeJS.ProcessEnv): void {
  const entries = freshProjectPeerAcl(backendUid, workerUid, workerPermissions);
  execFileSync(resolveNewProjectAclExecutable(env), ['--set', entries.join(','), '--', root], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000 });
}

const reserved = new Set(['teamskills', '.git', '.tower', '.tower-run-credentials']);
function assertPolicyTarget(root: string, policy: NewProjectStoragePolicy): void {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== policy.backendUid) {
    throw new Error('NEW_PROJECT_STORAGE_BACKEND_IDENTITY_MISMATCH');
  }
  const parent = path.dirname(root);
  if (!policy.projectParents.includes(parent) || fs.realpathSync(parent) !== parent
    || reserved.has(path.basename(root)) || path.basename(root).startsWith('.')) {
    throw new Error('NEW_PROJECT_STORAGE_ROOT_NOT_ALLOWED');
  }
}

/** Own the new inode and rollback only that inode on any preparation/scaffold failure. */
export function withNewProjectStorage(
  rootPath: string,
  scaffold: () => void,
  options: { requireNew?: boolean; env?: NodeJS.ProcessEnv } = {},
): void {
  const root = path.resolve(rootPath);
  let existing: fs.Stats | undefined;
  try { existing = fs.lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing) {
    if (options.requireNew || !existing.isDirectory() || existing.isSymbolicLink()) throw new Error('NEW_PROJECT_ROOT_ALREADY_EXISTS');
    scaffold();
    return;
  }
  const env = options.env ?? process.env;
  const policy = readNewProjectStoragePolicy(env);
  if (!policy && options.requireNew && env.NODE_ENV === 'production') throw new Error('NEW_PROJECT_STORAGE_INSTALLATION_REQUIRED');
  if (policy) assertPolicyTarget(root, policy);
  else fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root, { mode: policy ? 0o700 : 0o777 });
  const owned = fs.lstatSync(root);
  try {
    if (policy) {
      applyAcl(root, policy.backendUid, policy.workerUid, 'rwx', options.env);
      const managed = path.join(root, '.tower');
      fs.mkdirSync(managed, { mode: 0o700 });
      applyAcl(managed, policy.backendUid, policy.workerUid, 'r-x', options.env);
    }
    scaffold();
  } catch (error) {
    const current = fs.lstatSync(root, { throwIfNoEntry: false });
    if (current && current.dev === owned.dev && current.ino === owned.ino && current.isDirectory()) fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
