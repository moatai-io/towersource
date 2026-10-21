import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNewProjectStoragePolicy } from './new-project-storage-policy.js';
import { readTrustedNewProjectPolicyFile } from './new-project-storage-policy-file.js';
import { scaffoldProjectFolderForCreate } from './project-manager.js';
import { execFileSync, spawnSync } from 'node:child_process';
vi.mock('../skill/teamskills-source.js', () => ({ readTeamskillsSkillset: () => [] }));
const roots: string[] = [];
const originalLstat = fs.lstatSync.bind(fs);
let dir: string;
let file: string;
let policy: { version: number; mode: string; backendUid: number; workerUid: number; projectParents: string[] };
const env = () => ({ TOWER_NEW_PROJECT_STORAGE_POLICY_FILE: file });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-policy-file-')); roots.push(dir);
  file = path.join(dir, 'policy.json');
  policy = { version: 1, mode: 'shared-local', backendUid: process.getuid(), workerUid: process.getuid() === 65534 ? 65533 : 65534, projectParents: [dir] };
  // Host /tmp is deliberately world writable. Model ONLY that ancestor as a
  // trusted installation directory; real fixture files/modes/ACLs remain real.
  vi.spyOn(fs, 'lstatSync').mockImplementation(((p: any, options: any) => {
    const stat = originalLstat(p, options);
    return String(p) === os.tmpdir() ? Object.assign(stat, { mode: stat.mode & ~0o022 }) : stat;
  }) as any);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function write(value: unknown = policy) { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }

describe('new Project trusted policy file loader', () => {
  it('does not implicitly consult the legacy server policy file', () => {
    const previous = process.env.NODE_ENV;
    const previousWorker = process.env.TOWER_PRIMARY_WORKER_ID;
    process.env.NODE_ENV = 'production';
    delete process.env.TOWER_PRIMARY_WORKER_ID;
    try { expect(() => readNewProjectStoragePolicy(process.env)).toThrow('WORKER_IDENTITY_REQUIRED'); }
    finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
      if (previousWorker === undefined) delete process.env.TOWER_PRIMARY_WORKER_ID;
      else process.env.TOWER_PRIMARY_WORKER_ID = previousWorker;
    }
    expect(fs.lstatSync).not.toHaveBeenCalledWith('/etc/tower');
  });
  it('supports absent and env-only without modifying process env', () => {
    expect(readNewProjectStoragePolicy(env())).toBeUndefined();
    expect(readNewProjectStoragePolicy({ ...env(), TOWER_NEW_PROJECT_STORAGE_POLICY: JSON.stringify(policy) })).toEqual(policy);
  });
  it('loads file-only and accepts semantically equal env regardless of key order', () => {
    write();
    expect(readNewProjectStoragePolicy(env())).toEqual(policy);
    const reordered = { projectParents: [dir, dir], workerUid: policy.workerUid, backendUid: policy.backendUid, mode: 'shared-local', version: 1 };
    expect(readNewProjectStoragePolicy({ ...env(), TOWER_NEW_PROJECT_STORAGE_POLICY: JSON.stringify(reordered) })).toEqual(policy);
  });
  it('rejects conflicting env/file and malformed or unknown schema without echoing contents', () => {
    write();
    expect(() => readNewProjectStoragePolicy({ ...env(), TOWER_NEW_PROJECT_STORAGE_POLICY: JSON.stringify({ ...policy, workerUid: 76543 }) })).toThrow('POLICY_CONFLICT');
    fs.writeFileSync(file, 'synthetic invalid text');
    expect(() => readNewProjectStoragePolicy(env())).toThrow('POLICY_INVALID');
    write({ ...policy, mode: 'remote' });
    expect(() => readNewProjectStoragePolicy(env())).toThrow('POLICY_INVALID');
    write({ ...policy, command: 'not allowed' });
    expect(() => readNewProjectStoragePolicy(env())).toThrow('POLICY_INVALID');
  });
  it.each([0o620, 0o602])('rejects writable policy mode %s', mode => {
    write(); fs.chmodSync(file, mode);
    expect(() => readNewProjectStoragePolicy(env())).toThrow('FILE_UNTRUSTED');
  });
  it('rejects a writable ancestor and symlink at any component', () => {
    write(); fs.chmodSync(dir, 0o720);
    expect(() => readNewProjectStoragePolicy(env())).toThrow('FILE_UNTRUSTED');
    fs.chmodSync(dir, 0o700);
    const link = path.join(dir, 'link'); fs.symlinkSync(file, link);
    expect(() => readTrustedNewProjectPolicyFile(link)).toThrow('FILE_UNTRUSTED');
    const parentLink = path.join(dir, 'linked-parent'); fs.symlinkSync(dir, parentLink);
    expect(() => readTrustedNewProjectPolicyFile(path.join(parentLink, 'policy.json'))).toThrow('FILE_UNTRUSTED');
  });
  it('rejects bad owner metadata before reading content', () => {
    write();
    vi.mocked(fs.lstatSync).mockImplementation(((p: any, options: any) => {
      const stat = originalLstat(p, options);
      if (String(p) === os.tmpdir()) stat.mode &= ~0o022;
      if (String(p) === file) stat.uid = 98765;
      return stat;
    }) as any);
    const read = vi.spyOn(fs, 'readSync');
    expect(() => readNewProjectStoragePolicy(env())).toThrow('FILE_UNTRUSTED');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects hardlinks, directories and oversized data', () => {
    write(); fs.linkSync(file, path.join(dir, 'alias'));
    expect(() => readNewProjectStoragePolicy(env())).toThrow('FILE_UNTRUSTED');
    fs.unlinkSync(path.join(dir, 'alias'));
    expect(() => readTrustedNewProjectPolicyFile(dir)).toThrow('FILE_UNTRUSTED');
    fs.writeFileSync(file, 'x'.repeat(65537));
    expect(() => readNewProjectStoragePolicy(env())).toThrow('FILE_UNTRUSTED');
  });
  it('rejects relative/empty configured paths and does not execute shell content', () => {
    expect(() => readNewProjectStoragePolicy({ TOWER_NEW_PROJECT_STORAGE_POLICY_FILE: '' })).toThrow('FILE_UNTRUSTED');
    expect(() => readTrustedNewProjectPolicyFile('relative.json')).toThrow('FILE_UNTRUSTED');
    fs.writeFileSync(file, '$(touch synthetic-never-run)', { mode: 0o600 });
    expect(() => readNewProjectStoragePolicy(env())).toThrow('POLICY_INVALID');
  });
  it('blocks only new scaffold on conflict and leaves existing root unchanged', () => {
    write(); vi.stubEnv('TOWER_NEW_PROJECT_STORAGE_POLICY_FILE', file);
    vi.stubEnv('TOWER_NEW_PROJECT_STORAGE_POLICY', JSON.stringify({ ...policy, workerUid: 87654 }));
    const fresh = path.join(dir, 'new');
    expect(() => scaffoldProjectFolderForCreate(fresh, 'New', undefined, true)).toThrow('POLICY_CONFLICT');
    expect(fs.existsSync(fresh)).toBe(false);
    const existing = path.join(dir, 'existing'); fs.mkdirSync(existing, { mode: 0o700 });
    scaffoldProjectFolderForCreate(existing, 'Existing', undefined);
    expect(fs.statSync(existing).mode & 0o777).toBe(0o700);
  });
  it.skipIf(process.getuid() === 0 || spawnSync('/usr/bin/setfacl', ['--version']).status !== 0)('loads JSON through actual create scaffold and applies inherited upload-ready ACL', () => {
    write(); vi.stubEnv('TOWER_NEW_PROJECT_STORAGE_POLICY_FILE', file); vi.stubEnv('TOWER_NEW_PROJECT_STORAGE_POLICY', '');
    const root = path.join(dir, 'file-configured'); scaffoldProjectFolderForCreate(root, 'File configured', undefined, true);
    expect(execFileSync('/usr/bin/getfacl', ['-cpn', root], { encoding: 'utf8' })).toContain(`default:user:${policy.workerUid}:rwx`);
    expect(fs.existsSync(path.join(root, '.tower/skills/manifest.json'))).toBe(true);
  });
});
