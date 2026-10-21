import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scaffoldProjectFolderForCreate } from './project-manager.js';
import { receiveWorkerProjectFileUpload } from '../runtime-box/worker-project-file-upload.js';

vi.mock('../skill/project-skill-materializer.js', () => ({ materializeProjectRegistrySkills: ({ projectRootPath }: { projectRootPath: string }) => {
  const targetRootPath = path.join(projectRootPath, '.tower', 'skills');
  fs.mkdirSync(targetRootPath, { recursive: true });
  return { ok: true, targetRootPath, materialized: [], skipped: [] };
} }));
vi.mock('../skill/teamskills-source.js', () => ({ readTeamskillsSkillset: () => [] }));
const roots: string[] = [];
beforeEach(() => vi.stubEnv('NODE_ENV', 'test'));
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-project-root-')); roots.push(root); return root; }
const acl = (file: string) => execFileSync('getfacl', ['-cpn', file], { encoding: 'utf8' });
const hasAcl = process.platform === 'linux' && spawnSync('setfacl', ['--version']).status === 0;

describe('new Project filesystem permission policy', () => {
  it('does not widen adopted/private roots or user files on repeated scaffolding', () => {
    const root = fixture();
    fs.chmodSync(root, 0o700);
    fs.writeFileSync(path.join(root, 'private.txt'), 'private', { mode: 0o600 });
    fs.mkdirSync(path.join(root, '.git'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, '.env'), 'synthetic', { mode: 0o600 });
    scaffoldProjectFolderForCreate(root, 'Project', undefined);
    scaffoldProjectFolderForCreate(root, 'Project update', undefined);
    expect(fs.statSync(root).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'private.txt')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, '.git')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, '.env')).mode & 0o777).toBe(0o600);
  });

  it('does not infer shared-Worker group authority for a fresh isolated root', () => {
    const parent = fixture();
    const baseline = path.join(parent, 'baseline');
    fs.mkdirSync(baseline);
    const root = path.join(parent, 'isolated');
    scaffoldProjectFolderForCreate(root, 'Isolated', undefined);
    expect(fs.statSync(root).mode & 0o7777).toBe(fs.statSync(baseline).mode & 0o7777);
  });
});

describe.skipIf(!hasAcl)('provisioned shared Project inheritance', () => {
  it('preserves restrictive named ACL mask rather than silently authorizing group write', () => {
    const root = fixture();
    execFileSync('setfacl', ['-m', 'u:65534:rwx,m::r-x', root]);
    const before = acl(root);
    scaffoldProjectFolderForCreate(root, 'Restricted', undefined);
    expect(acl(root)).toBe(before);
    expect(acl(root)).toContain('user:65534:rwx\t#effective:r-x');
  });

  it('inherits root, Backend mkdir/file and Worker upload/new mkdir policies without chmod', async () => {
    const parent = fixture();
    fs.chmodSync(parent, 0o2770);
    execFileSync('setfacl', ['-m', 'd:u::rwx,d:g::rwx,d:m::rwx,d:o::---', parent]);
    const root = path.join(parent, 'new-agent');
    scaffoldProjectFolderForCreate(root, 'New Agent', undefined);
    expect(fs.statSync(root).mode & 0o7777).toBe(0o2770);
    expect(fs.statSync(path.join(root, 'AGENTS.md')).mode & 0o777).toBe(0o660);
    expect(acl(root)).toContain('default:group::rwx');
    fs.mkdirSync(path.join(root, 'backend/new'), { recursive: true });
    fs.writeFileSync(path.join(root, 'backend/new/file.txt'), 'backend');
    const target = path.join(root, 'worker/uploads/new/file.txt');
    await receiveWorkerProjectFileUpload({ target, expectedBytes: 6, chunks: (async function* () { yield 'worker'; })() });
    for (const dir of ['backend', 'backend/new', 'worker', 'worker/uploads', 'worker/uploads/new']) {
      expect(fs.statSync(path.join(root, dir)).mode & 0o7777).toBe(0o2770);
      expect(acl(path.join(root, dir))).toContain('default:group::rwx');
    }
    expect(fs.statSync(target).mode & 0o777).toBe(0o660);
    expect(fs.statSync(path.join(root, 'backend/new/file.txt')).mode & 0o777).toBe(0o660);
    const before = acl(root);
    scaffoldProjectFolderForCreate(root, 'Update', undefined);
    expect(acl(root)).toBe(before);
    expect(fs.readFileSync(target, 'utf8')).toBe('worker');
  });
});
