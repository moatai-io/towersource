import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNewProjectStoragePolicy, withNewProjectStorage } from './new-project-storage-policy.js';
import { scaffoldProjectFolderForCreate } from './project-manager.js';
import { receiveWorkerProjectFileUpload } from '../runtime-box/worker-project-file-upload.js';
vi.mock('../skill/teamskills-source.js', () => ({ readTeamskillsSkillset: () => [] }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-new-root-policy-')); roots.push(parent);
  const policy = { version: 1, mode: 'shared-local', backendUid: process.getuid(), workerUid: process.getuid() === 65534 ? 65533 : 65534, projectParents: [parent] };
  return { parent, root: path.join(parent, 'new-agent'), policy, env: { TOWER_NEW_PROJECT_STORAGE_POLICY: JSON.stringify(policy) } };
}
const acl = (p: string) => execFileSync('/usr/bin/getfacl', ['-cpn', p], { encoding: 'utf8' });
const hasAcl = process.platform === 'linux' && process.getuid() !== 0 && spawnSync('/usr/bin/setfacl', ['--version']).status === 0;

describe('server installation new Project policy', () => {
  it('does not turn isolated/remote or invalid config into shared policy', () => {
    expect(readNewProjectStoragePolicy({})).toBeUndefined();
    for (const value of ['bad', 'null', JSON.stringify({ ...fixture().policy, mode: 'isolated' }), JSON.stringify({ ...fixture().policy, workerUid: 0 })]) {
      expect(() => readNewProjectStoragePolicy({ TOWER_NEW_PROJECT_STORAGE_POLICY: value })).toThrow('POLICY_INVALID');
    }
  });
  it('keeps unset ordinary mkdir policy outside production without silently adding group write', () => {
    const { parent, root } = fixture();
    fs.mkdirSync(path.join(parent, 'baseline'));
    withNewProjectStorage(root, () => {}, { env: { NODE_ENV: 'test' } });
    expect(fs.statSync(root).mode & 0o7777).toBe(fs.statSync(path.join(parent, 'baseline')).mode & 0o7777);
  });
  it('fails closed for a fresh production Project when trusted Worker installation identity is absent', () => {
    const { root } = fixture();
    const scaffold = vi.fn();
    expect(() => withNewProjectStorage(root, scaffold, { env: { NODE_ENV: 'production' }, requireNew: true }))
      .toThrow('NEW_PROJECT_STORAGE_WORKER_IDENTITY_REQUIRED');
    expect(scaffold).not.toHaveBeenCalled();
    expect(fs.existsSync(root)).toBe(false);
  });
  it('does not reinterpret an existing Project refresh as fresh production provisioning', () => {
    const { root } = fixture();
    fs.mkdirSync(root, { mode: 0o700 });
    withNewProjectStorage(root, () => fs.writeFileSync(path.join(root, 'kept'), 'ok'), { env: { NODE_ENV: 'production' } });
    expect(fs.readFileSync(path.join(root, 'kept'), 'utf8')).toBe('ok');
  });
  it('preserves an existing/adopted private root and refuses requireNew collision without deleting it', () => {
    const { root, env } = fixture();
    fs.mkdirSync(root, { mode: 0o700 }); fs.writeFileSync(path.join(root, 'keep'), 'keep', { mode: 0o600 });
    withNewProjectStorage(root, () => {}, { env });
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(() => withNewProjectStorage(root, () => {}, { env, requireNew: true })).toThrow('ALREADY_EXISTS');
    expect(fs.readFileSync(path.join(root, 'keep'), 'utf8')).toBe('keep');
  });
  it('rolls back its own new tree if later scaffold fails', () => {
    const { root } = fixture();
    expect(() => withNewProjectStorage(root, () => { fs.writeFileSync(path.join(root, 'partial'), 'x'); throw new Error('seed failed'); }, { env: {}, requireNew: true })).toThrow('seed failed');
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe.skipIf(!hasAcl)('new-root named ACL actual filesystem behavior', () => {
  it('integrates actual scaffold, ordinary nested mkdir, uploads, managed read-only and run-private permissions', async () => {
    const { parent, root, policy, env } = fixture();
    const parentAcl = acl(parent);
    withNewProjectStorage(root, () => scaffoldProjectFolderForCreate(root, 'Shared Agent', undefined), { env, requireNew: true });
    expect(acl(parent)).toBe(parentAcl);
    expect(acl(root)).toContain(`user:${policy.workerUid}:rwx`);
    expect(acl(root)).toContain(`default:user:${policy.backendUid}:rwx`);
    expect(acl(root)).toContain('other::---');
    expect(acl(path.join(root, 'AGENTS.md'))).toContain(`user:${policy.workerUid}:rwx\t#effective:rw-`);
    fs.mkdirSync(path.join(root, 'new/subdir'), { recursive: true });
    const uploaded = path.join(root, 'new/subdir/uploads/file.txt');
    await receiveWorkerProjectFileUpload({ target: uploaded, expectedBytes: 4, chunks: (async function* () { yield 'test'; })() });
    expect(acl(uploaded)).toContain(`user:${policy.workerUid}:rwx\t#effective:rw-`);
    expect(acl(uploaded)).toContain(`user:${policy.backendUid}:rwx\t#effective:rw-`);
    expect(acl(path.dirname(uploaded))).toContain(`default:user:${policy.workerUid}:rwx`);
    // Real materializer created its manifest inside the pre-seeded managed ACL boundary.
    const manifest = path.join(root, '.tower/skills/manifest.json');
    expect(fs.existsSync(manifest)).toBe(true);
    expect(acl(manifest)).toContain(`user:${policy.workerUid}:r-x\t#effective:r--`);
    expect(acl(path.join(root, '.tower/skills'))).toContain(`default:user:${policy.workerUid}:r-x`);
    // Ordinary newly initialized Project Git supports the two trusted services.
    fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git/config'), 'synthetic');
    expect(acl(path.join(root, '.git/config'))).toContain(`user:${policy.workerUid}:rwx\t#effective:rw-`);
    // Same creation primitives as run-scoped credential code, no real secret.
    fs.mkdirSync(path.join(root, '.tower-run-credentials'), { mode: 0o700 });
    const run = fs.mkdtempSync(path.join(root, '.tower-run-credentials/run-'));
    fs.writeFileSync(path.join(run, 'credential'), 'synthetic', { mode: 0o600 });
    fs.writeFileSync(path.join(root, '.env'), 'synthetic', { mode: 0o600 });
    expect(acl(run)).toContain('mask::---');
    expect(acl(path.join(run, 'credential'))).toContain('mask::---');
    expect(acl(path.join(root, '.env'))).toContain('mask::---');
    const before = acl(root); scaffoldProjectFolderForCreate(root, 'Update', undefined);
    expect(acl(root)).toBe(before);
  });
  it('refuses another identity, non-allowlisted root, nested root and reserved system store', () => {
    const { root, parent, env, policy } = fixture();
    expect(() => withNewProjectStorage(root, () => {}, { env: { TOWER_NEW_PROJECT_STORAGE_POLICY: JSON.stringify({ ...policy, backendUid: policy.workerUid, workerUid: policy.backendUid }) } })).toThrow('IDENTITY_MISMATCH');
    expect(() => withNewProjectStorage(path.join(parent, 'nested', 'root'), () => {}, { env })).toThrow('ROOT_NOT_ALLOWED');
    expect(() => withNewProjectStorage(path.join(parent, 'teamskills'), () => {}, { env })).toThrow('ROOT_NOT_ALLOWED');
    expect(fs.existsSync(root)).toBe(false);
  });
  it('refuses symlink parent and does not mutate its target', () => {
    const { parent, policy } = fixture();
    const alias = path.join(parent, 'alias'); fs.symlinkSync(parent, alias);
    expect(() => withNewProjectStorage(path.join(alias, 'bad'), () => {}, { env: { TOWER_NEW_PROJECT_STORAGE_POLICY: JSON.stringify({ ...policy, projectParents: [alias] }) } })).toThrow('ROOT_NOT_ALLOWED');
    expect(fs.existsSync(path.join(parent, 'bad'))).toBe(false);
  });
  it('rolls back after the ACL executable fails without calling scaffold or deleting siblings', () => {
    const { root, parent, env } = fixture();
    fs.writeFileSync(path.join(parent, 'keep'), 'original');
    const scaffold = vi.fn();
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('ACL unsupported'); });
    expect(() => withNewProjectStorage(root, scaffold, { env })).toThrow('ACL unsupported');
    expect(scaffold).not.toHaveBeenCalled();
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readFileSync(path.join(parent, 'keep'), 'utf8')).toBe('original');
  });
  it('removes the owned new ACL-prepared root after a later scaffold failure', () => {
    const { root, env } = fixture();
    expect(() => withNewProjectStorage(root, () => { throw new Error('after acl'); }, { env })).toThrow('after acl');
    expect(fs.existsSync(root)).toBe(false);
  });
});
