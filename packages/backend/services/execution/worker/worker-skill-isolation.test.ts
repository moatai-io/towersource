import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { computeBundleDigest } from '../../skill/skill-bundle-resolver.js';
import { managedSkillReadOnlyBinds, managedSkillSandboxArgs } from './worker-server.js';

it('explains hidden manifest without diagnosing a Gateway failure in sandbox guidance', () => {
  const source = fs.readFileSync(new URL('./worker-server.ts', import.meta.url), 'utf8');
  expect(source).toContain('Managed skill projection intentionally hides .tower/skills/manifest.json');
  expect(source).toContain('Missing manifest inside the sandbox is not evidence of missing skill registration or Gateway configuration');
  expect(source).toContain('use credential selection and materialization evidence, not manifest visibility');
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-skill-isolation-')); roots.push(root);
  const project = path.join(root, 'project'); const canonical = path.join(root, 'canonical');
  fs.mkdirSync(path.join(project, '.tower/skills'), { recursive: true });
  fs.mkdirSync(canonical); fs.writeFileSync(path.join(project, 'ordinary.txt'), 'ordinary file');
  function skill(name: string) {
    const source = path.join(canonical, name); fs.mkdirSync(source);
    const content = `# ${name}\n`; fs.writeFileSync(path.join(source, 'SKILL.md'), content);
    const local = path.join(project, '.tower/skills', name); fs.mkdirSync(local);
    fs.writeFileSync(path.join(local, 'SKILL.md'), 'stale control copy');
    return { name, storageMode: 'bind-ro', bundleDigest: computeBundleDigest([{ relativePath: 'SKILL.md', sizeBytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }]) };
  }
  function manifest(entries: unknown[]) {
    fs.writeFileSync(path.join(project, '.tower/skills/manifest.json'), JSON.stringify({ schemaVersion: 3, managedBy: 'tower-project-skill-runtime-layer', skills: entries }));
  }
  return { project, canonical, skill, manifest };
}

describe('Worker managed skill failure isolation', () => {
  it.each(['storage', 'digest', 'missing', 'unsafe', 'escape'])('isolates %s failure without discarding a healthy skill', async (failure) => {
    const f = fixture(); const healthy = f.skill('healthy'); const broken = f.skill('broken');
    if (failure === 'storage') delete (broken as { storageMode?: string }).storageMode;
    if (failure === 'digest') broken.bundleDigest = 'sha256:invalid';
    if (failure === 'missing') fs.rmSync(path.join(f.canonical, 'broken'), { recursive: true });
    if (failure === 'unsafe') fs.writeFileSync(path.join(f.canonical, 'broken/.env'), 'synthetic fixture');
    if (failure === 'escape') { fs.rmSync(path.join(f.canonical, 'broken'), { recursive: true }); fs.symlinkSync(f.project, path.join(f.canonical, 'broken')); }
    f.manifest([broken, healthy]);
    const plan = await managedSkillReadOnlyBinds(f.project, f.canonical);
    expect(plan.managed).toBe(true);
    expect(plan.binds).toEqual([{ source: path.join(f.canonical, 'healthy'), target: '/workspace/.tower/skills/healthy' }]);
    expect(plan.skipped).toHaveLength(1); expect(plan.skipped[0].name).toBe('broken');
    const args = managedSkillSandboxArgs(plan);
    expect(args.slice(0, 2)).toEqual(['--tmpfs', '/workspace/.tower/skills']);
    expect(args).not.toContain('/workspace/.tower/skills/broken');
    expect(fs.readFileSync(path.join(f.project, 'ordinary.txt'), 'utf8')).toBe('ordinary file');
  });

  it('masks all skill copies for an unreadable manifest or unavailable source root', async () => {
    const f = fixture(); f.manifest([f.skill('healthy')]);
    const missing = await managedSkillReadOnlyBinds(f.project);
    expect(missing).toMatchObject({ managed: true, binds: [], skipped: [{ name: 'healthy', reason: 'source_root_unavailable' }] });
    fs.writeFileSync(path.join(f.project, '.tower/skills/manifest.json'), '{');
    const corrupt = await managedSkillReadOnlyBinds(f.project, f.canonical);
    expect(corrupt).toMatchObject({ managed: true, binds: [], skipped: [{ name: 'manifest', reason: 'unreadable' }] });
    expect(managedSkillSandboxArgs(corrupt)).toEqual(['--tmpfs', '/workspace/.tower/skills']);
  });

  it('does not treat missing or legacy manifests as bind-ro managed', async () => {
    const f = fixture();
    expect(await managedSkillReadOnlyBinds(f.project)).toEqual({ managed: false, binds: [], skipped: [] });
    fs.writeFileSync(path.join(f.project, '.tower/skills/manifest.json'), JSON.stringify({ schemaVersion: 2 }));
    expect(managedSkillSandboxArgs(await managedSkillReadOnlyBinds(f.project))).toEqual([]);
  });

  const bwrap = spawnSync('which', ['bwrap'], { encoding: 'utf8' }).stdout?.trim();
  const usable = bwrap && spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-all', '--', 'true']).status === 0;
  it.skipIf(!usable)('reads ordinary files and healthy skills but cannot read a broken control copy inside bwrap', async () => {
    const f = fixture(); const healthy = f.skill('healthy'); const broken = f.skill('broken'); broken.bundleDigest = 'sha256:invalid'; f.manifest([healthy, broken]);
    const plan = await managedSkillReadOnlyBinds(f.project, f.canonical);
    const result = spawnSync(bwrap!, ['--tmpfs', '/', '--ro-bind-try', '/nix/store', '/nix/store', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--bind', f.project, '/workspace', ...managedSkillSandboxArgs(plan), '--', 'sh', '-c', 'cat /workspace/ordinary.txt; cat /workspace/.tower/skills/healthy/SKILL.md; test ! -e /workspace/.tower/skills/broken/SKILL.md'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ordinary file'); expect(result.stdout).toContain('# healthy');
    expect(result.stdout).not.toContain('stale control copy');
  });
});
