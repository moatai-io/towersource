import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveNewProjectAclExecutable, resolveProjectAclExecutables } from './new-project-acl-executable.js';
import { withNewProjectStorage } from './new-project-storage-policy.js';
import { receiveWorkerProjectFileUpload } from '../runtime-box/worker-project-file-upload.js';
import { execFileSync } from 'node:child_process';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const hostAvailable = fs.existsSync('/usr/bin/setfacl');

describe('trusted installation ACL executable', () => {
  it.skipIf(!hostAvailable)('uses the validated Host fallback rather than arbitrary PATH', () => {
    expect(resolveNewProjectAclExecutable({ PATH: '/untrusted/project/bin' })).toBe('/usr/bin/setfacl');
  });
  it.skipIf(!hostAvailable)('resolves both fd ACL tools independently of Project PATH', () => {
    expect(resolveProjectAclExecutables({ PATH: '/untrusted/project/bin' })).toEqual({ getfacl: '/usr/bin/getfacl', setfacl: '/usr/bin/setfacl' });
  });
  it.each(['setfacl', '/tmp/setfacl', '/workspace/bin/setfacl', '', '/nix/store/invalid-acl/bin/setfacl', '/usr/bin/../bin/setfacl'])(
    'rejects unknown selected tool %s without execution', executable => {
      expect(() => resolveNewProjectAclExecutable({ TOWER_PROJECT_SETFACL_BIN: executable })).toThrow('EXECUTABLE_UNTRUSTED');
    },
  );
  it('fails closed on an unavailable Nix tool rather than falling back to Host', () => {
    expect(() => resolveNewProjectAclExecutable({ TOWER_PROJECT_SETFACL_BIN: `/nix/store/${'0'.repeat(32)}-acl-0-bin/bin/setfacl` })).toThrow('EXECUTABLE_UNTRUSTED');
  });
  it.skipIf(!hostAvailable).each(['owner', 'writable', 'symlink', 'setuid'])('rejects Host %s metadata', kind => {
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: any, options: any) => {
      const stat = lstat(p, options);
      if (String(p) === '/usr/bin/setfacl') {
        if (kind === 'owner') stat.uid = 98765;
        if (kind === 'writable') stat.mode |= 0o020;
        if (kind === 'symlink') stat.isSymbolicLink = () => true;
        if (kind === 'setuid') stat.mode |= 0o4000;
      }
      return stat;
    }) as any);
    expect(() => resolveNewProjectAclExecutable({})).toThrow('EXECUTABLE_UNTRUSTED');
  });
  it('rolls back opted-in new root if the selected tool is invalid', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-acl-invalid-')); roots.push(parent);
    const root = path.join(parent, 'new');
    const policy = { version: 1, mode: 'shared-local', backendUid: process.getuid(), workerUid: 65534, projectParents: [parent] };
    const scaffold = vi.fn();
    expect(() => withNewProjectStorage(root, scaffold, { env: { TOWER_NEW_PROJECT_STORAGE_POLICY: JSON.stringify(policy), TOWER_PROJECT_SETFACL_BIN: '/tmp/not-trusted' } })).toThrow();
    expect(scaffold).not.toHaveBeenCalled(); expect(fs.existsSync(root)).toBe(false);
  });
  it('pins both Nix Backend launchers and install checks to the ACL package output', () => {
    const flake = fs.readFileSync(path.join(process.cwd(), 'flake.nix'), 'utf8');
    for (const launcher of ['shadow', 'production']) {
      expect(flake).toContain(`wrapProgram "$out/bin/tower-app-start-${launcher}" \\\n            --set TOWER_PROJECT_SETFACL_BIN "\${lib.getBin pkgs.acl}/bin/setfacl"`);
    }
    expect(flake).toContain('towerProjectAcl = lib.getBin pkgs.acl;');
    expect(flake).toContain('test -x "${lib.getBin pkgs.acl}/bin/setfacl"');
  });
});

// Exact store executable supplied only by the local test command after flake eval.
const nixTool = process.env.TOWER_TEST_NIX_SETFACL;
it.skipIf(!nixTool)('uses the evaluated real Nix ACL executable for new root and upload inheritance', async () => {
  const executable = resolveNewProjectAclExecutable({ TOWER_PROJECT_SETFACL_BIN: nixTool });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-nix-acl-')); roots.push(parent);
  const root = path.join(parent, 'new');
  const policy = { version: 1, mode: 'shared-local', backendUid: process.getuid(), workerUid: 65534, projectParents: [parent] };
  withNewProjectStorage(root, () => fs.writeFileSync(path.join(root, 'backend.txt'), 'ok'), { env: { TOWER_NEW_PROJECT_STORAGE_POLICY: JSON.stringify(policy), TOWER_PROJECT_SETFACL_BIN: executable } });
  const uploaded = path.join(root, 'uploads/new/file.txt');
  await receiveWorkerProjectFileUpload({ target: uploaded, expectedBytes: 2, chunks: (async function* () { yield 'ok'; })() });
  const getfacl = path.join(path.dirname(executable), 'getfacl');
  expect(execFileSync(getfacl, ['-cpn', uploaded], { encoding: 'utf8' })).toContain('user:65534:rwx\t#effective:rw-');
  expect(execFileSync(getfacl, ['-cpn', path.join(root, '.tower')], { encoding: 'utf8' })).toContain('user:65534:r-x');
});
