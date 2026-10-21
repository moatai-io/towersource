import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { computeBundleDigest } from './skill-bundle-resolver.js';
import { scanSkillBundleForReadOnlyMount } from './skill-materialization-scanner.js';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTeamskill(root: string, name: string, extra: Record<string, string> = {}): string {
  const skillRoot = path.join(root, 'skills', name);
  fs.mkdirSync(skillRoot, { recursive: true });
  const files = {
    'SKILL.md': `---\nname: ${name}\ndescription: test\n---\n`,
    'skill.yaml': `name: ${name}\nversion: 1.0.0\n`,
    'scripts/run.sh': '#!/bin/sh\necho ok\n',
    ...extra,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(skillRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return skillRoot;
}

function sourceDigest(teamskillsRoot: string, name: string): string {
  const source = path.join(teamskillsRoot, 'skills', name);
  const scan = scanSkillBundleForReadOnlyMount(source);
  return computeBundleDigest(scan.filesAllowed.map(relativePath => {
    const bytes = fs.readFileSync(path.join(source, relativePath));
    return { relativePath, sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }));
}

function writeProjectManifest(projectRoot: string, names: string[], schemaVersion = 3, teamskillsRoot?: string): void {
  const root = path.join(projectRoot, '.tower', 'skills');
  fs.mkdirSync(root, { recursive: true });
  for (const name of names) {
    const target = path.join(root, name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), '# control file\n');
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schemaVersion,
    managedBy: schemaVersion === 3 ? 'tower-project-skill-runtime-layer' : 'tower-project-skill-materializer',
    skills: names.map((name) => ({ name, ...(schemaVersion === 3 ? { storageMode: 'bind-ro', bundleDigest: sourceDigest(teamskillsRoot!, name) } : {}) })),
  }));
}

async function loadWithTeamskills(teamskillsRoot: string) {
  vi.resetModules();
  process.env.TEAMSKILLS_PROJECT_ROOT = teamskillsRoot;
  return import('./runtime-skill-bind-mount.js');
}

afterEach(() => {
  vi.resetModules();
  delete process.env.TEAMSKILLS_PROJECT_ROOT;
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('runtime skill bind-ro MVP', () => {
  it('enables schema v3 bind-ro desired state without a canary flag', async () => {
    const teamskillsRoot = tempDir('teamskills-');
    const projectRoot = tempDir('project-');
    writeProjectManifest(projectRoot, []);
    const manifestPath = path.join(projectRoot, '.tower/skills/manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 3, managedBy: 'tower-project-skill-runtime-layer', skills: [{ name: 'gws', storageMode: 'bind-ro' }] }));
    const legacyRoot = tempDir('legacy-project-');
    writeProjectManifest(legacyRoot, ['gws'], 2);
    const { projectUsesSkillBindMount } = await loadWithTeamskills(teamskillsRoot);

    expect(projectUsesSkillBindMount({ id: 'p1', name: 'Acme', rootPath: projectRoot })).toBe(true);
    expect(projectUsesSkillBindMount({ id: 'p2', name: 'Legacy', rootPath: legacyRoot })).toBe(false);
  });

  it('builds per-skill read-only Docker mounts from the project manifest', async () => {
    const teamskillsRoot = tempDir('teamskills-');
    const projectRoot = tempDir('project-');
    const source = writeTeamskill(teamskillsRoot, 'gws');
    writeProjectManifest(projectRoot, ['gws'], 3, teamskillsRoot);
    const { buildRuntimeSkillBindMountPlan, runtimeSkillDockerMountArgs } = await loadWithTeamskills(teamskillsRoot);

    const plan = buildRuntimeSkillBindMountPlan(projectRoot);

    expect(plan.enabled).toBe(true);
    expect(plan.skipped).toEqual([]);
    expect(plan.mounts).toEqual([{
      name: 'gws',
      sourcePath: fs.realpathSync(source),
      targetPath: '/workspace/.tower/skills/gws',
    }]);
    expect(runtimeSkillDockerMountArgs(plan)).toEqual([
      '--mount',
      `type=bind,src=${fs.realpathSync(source)},dst=/workspace/.tower/skills/gws,readonly,bind-propagation=rprivate`,
    ]);
  });

  it('refuses a source whose bytes changed while mtime and size stayed the same', async () => {
    const teamskillsRoot = tempDir('teamskills-');
    const projectRoot = tempDir('project-');
    const source = writeTeamskill(teamskillsRoot, 'gws');
    writeProjectManifest(projectRoot, ['gws'], 3, teamskillsRoot);
    const skillPath = path.join(source, 'SKILL.md');
    const fixedTime = new Date('2024-01-01T00:00:00.000Z');
    fs.utimesSync(skillPath, fixedTime, fixedTime);
    const stat = fs.statSync(skillPath);
    const before = fs.readFileSync(skillPath, 'utf8');
    fs.writeFileSync(skillPath, before.replace('test', 'rest'));
    fs.utimesSync(skillPath, fixedTime, fixedTime);
    expect(fs.statSync(skillPath).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.statSync(skillPath).size).toBe(stat.size);
    const { buildRuntimeSkillBindMountPlan, runtimeSkillDockerMountArgs } = await loadWithTeamskills(teamskillsRoot);
    const plan = buildRuntimeSkillBindMountPlan(projectRoot);
    expect(plan).toMatchObject({ enabled: false, mounts: [], skipped: [{ name: 'gws', reason: 'source_manifest_mismatch' }] });
    expect(runtimeSkillDockerMountArgs(plan)).toEqual([]);
  });

  it('falls back as a whole when a manifest source is unsafe', async () => {
    const teamskillsRoot = tempDir('teamskills-');
    const projectRoot = tempDir('project-');
    writeTeamskill(teamskillsRoot, 'safe');
    writeTeamskill(teamskillsRoot, 'unsafe', { '.env': 'TOKEN=value' });
    writeProjectManifest(projectRoot, ['safe', 'unsafe'], 3, teamskillsRoot);
    const { buildRuntimeSkillBindMountPlan, runtimeSkillDockerMountArgs } = await loadWithTeamskills(teamskillsRoot);

    const plan = buildRuntimeSkillBindMountPlan(projectRoot);

    expect(plan.enabled).toBe(false);
    expect(plan.mounts.map((mount) => mount.name)).toEqual(['safe']);
    expect(plan.skipped).toEqual([{ name: 'unsafe', reason: 'source_scan_failed' }]);
    expect(runtimeSkillDockerMountArgs(plan)).toEqual([]);
  });

  it('allows a read-only source with generated-file warnings', async () => {
    const teamskillsRoot = tempDir('teamskills-');
    const projectRoot = tempDir('project-');
    writeTeamskill(teamskillsRoot, 'warning', { 'scripts/__pycache__/run.pyc': 'compiled' });
    writeProjectManifest(projectRoot, ['warning'], 3, teamskillsRoot);
    const { buildRuntimeSkillBindMountPlan } = await loadWithTeamskills(teamskillsRoot);

    expect(buildRuntimeSkillBindMountPlan(projectRoot)).toMatchObject({
      enabled: true,
      mounts: [{ name: 'warning', targetPath: '/workspace/.tower/skills/warning' }],
      skipped: [],
    });
  });

  it('allows a source larger than the copy transport limit', async () => {
    const teamskillsRoot = tempDir('teamskills-');
    const projectRoot = tempDir('project-');
    writeTeamskill(teamskillsRoot, 'large', { 'references/large.bin': 'x'.repeat(3 * 1024 * 1024) });
    writeProjectManifest(projectRoot, ['large'], 3, teamskillsRoot);
    const { buildRuntimeSkillBindMountPlan } = await loadWithTeamskills(teamskillsRoot);

    expect(buildRuntimeSkillBindMountPlan(projectRoot)).toMatchObject({
      enabled: true,
      mounts: [{ name: 'large', targetPath: '/workspace/.tower/skills/large' }],
      skipped: [],
    });
  });

  it('does not mount manifest entries without an existing project fallback target', async () => {
    const teamskillsRoot = tempDir('teamskills-');
    const projectRoot = tempDir('project-');
    writeTeamskill(teamskillsRoot, 'gws');
    writeProjectManifest(projectRoot, []);
    const manifestPath = path.join(projectRoot, '.tower', 'skills', 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 3,
      managedBy: 'tower-project-skill-runtime-layer',
      skills: [{ name: 'gws', storageMode: 'bind-ro', bundleDigest: sourceDigest(teamskillsRoot, 'gws') }],
    }));
    const { buildRuntimeSkillBindMountPlan } = await loadWithTeamskills(teamskillsRoot);

    expect(buildRuntimeSkillBindMountPlan(projectRoot)).toMatchObject({
      enabled: false,
      mounts: [],
      skipped: [{ name: 'gws', reason: 'materialized_target_missing' }],
    });
  });

  it('rejects a symlink fallback target instead of mounting over it', async () => {
    const teamskillsRoot = tempDir('teamskills-');
    const projectRoot = tempDir('project-');
    writeTeamskill(teamskillsRoot, 'gws');
    writeProjectManifest(projectRoot, []);
    const skillsRoot = path.join(projectRoot, '.tower', 'skills');
    const outside = tempDir('outside-');
    fs.symlinkSync(outside, path.join(skillsRoot, 'gws'), 'dir');
    fs.writeFileSync(path.join(skillsRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 3,
      managedBy: 'tower-project-skill-runtime-layer',
      skills: [{ name: 'gws', storageMode: 'bind-ro', bundleDigest: sourceDigest(teamskillsRoot, 'gws') }],
    }));
    const { buildRuntimeSkillBindMountPlan } = await loadWithTeamskills(teamskillsRoot);

    expect(buildRuntimeSkillBindMountPlan(projectRoot)).toMatchObject({
      enabled: false,
      mounts: [],
      skipped: [{ name: 'gws', reason: 'materialized_target_not_directory' }],
    });
  });
});