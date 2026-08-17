import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeLegacyManagedSkill(home: string, name: string, files: Record<string, string> = {}): void {
  const dir = path.join(home, 'tower', 'skills', 'managed', name);
  fs.mkdirSync(dir, { recursive: true });
  const defaultFiles = {
    'SKILL.md': `---\nname: ${name}\ndescription: legacy ${name}\nversion: 1.0.0\n---\n\n# legacy ${name}\n`,
    'scripts/run.sh': '#!/usr/bin/env bash\necho legacy\n',
  };
  for (const [relativePath, content] of Object.entries({ ...defaultFiles, ...files })) {
    const target = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function writeTeamskillsSkill(home: string, name: string, files: Record<string, string> = {}): void {
  const dir = path.join(home, 'workspace', 'projects', 'teamskills', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const defaultFiles = {
    'SKILL.md': `---\nname: ${name}\ndescription: org ${name}\nversion: 2.0.0\n---\n\n# org ${name}\n`,
    'skill.yaml': `name: ${name}\nversion: 2.0.0\nrequiredSecrets: [ORG_TOKEN]\n`,
    'scripts/run.sh': '#!/usr/bin/env bash\necho org\n',
  };
  for (const [relativePath, content] of Object.entries({ ...defaultFiles, ...files })) {
    const target = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

async function loadWithHome(home: string) {
  vi.resetModules();
  process.env.TEAMSKILLS_PROJECT_ROOT = path.join(home, 'workspace', 'projects', 'teamskills');
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return { ...actual, default: { ...actual.default, homedir: () => home }, homedir: () => home };
  });
  return import('./project-skill-materializer.ts');
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('os');
  delete process.env.TEAMSKILLS_PROJECT_ROOT;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('project-skill-materializer', () => {
  it('materializes a teamskills bundle into project .tower/skills and writes manifest', async () => {
    const home = makeTempDir('tower-project-skill-home-');
    const projectRoot = makeTempDir('tower-project-root-');
    writeTeamskillsSkill(home, 'youtube-transcript', { 'references/guide.md': 'guide' });

    const { materializeProjectRegistrySkills } = await loadWithHome(home);
    const result = materializeProjectRegistrySkills({
      projectRootPath: projectRoot,
      skillNames: ['youtube-transcript'],
      now: new Date('2026-06-09T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.materialized).toHaveLength(1);
    expect(fs.existsSync(path.join(projectRoot, '.tower', 'skills', 'youtube-transcript', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.tower', 'skills', 'youtube-transcript', 'scripts', 'run.sh'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.tower', 'skills', 'youtube-transcript', 'references', 'guide.md'))).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, '.tower', 'skills', 'manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      managedBy: 'tower-project-skill-materializer',
      skills: [{
        name: 'youtube-transcript',
        canonicalId: 'tower://org/teamskills/youtube-transcript',
        bundleDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        version: '2.0.0',
        sourceKind: 'teamskills',
        catalog: 'teamskills',
        ownership: 'org',
        requiredSecrets: ['ORG_TOKEN'],
        sourceProject: 'teamskills',
        sourcePath: 'skills/youtube-transcript',
        runtimePath: '/workspace/.tower/skills/youtube-transcript',
      }],
    });
    expect(manifest.skills[0].files.map((f: any) => f.relativePath).sort()).toEqual([
      'SKILL.md',
      'references/guide.md',
      'scripts/run.sh',
      'skill.yaml',
    ]);
  });

  it('writes a bind-ro manifest and keeps only control files for every safe bundle', async () => {
    const home = makeTempDir('tower-project-skill-home-');
    const projectRoot = makeTempDir('tower-project-root-');
    writeTeamskillsSkill(home, 'large-skill', {
      'references/guide.md': 'guide',
      'references/large.bin': 'x'.repeat(3 * 1024 * 1024),
    });

    const { materializeProjectRegistrySkills } = await loadWithHome(home);
    const result = materializeProjectRegistrySkills({
      projectRootPath: projectRoot,
      skillNames: ['large-skill'],
      storageMode: 'bind-ro',
      now: new Date('2026-07-10T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.materialized).toEqual([expect.objectContaining({
      name: 'large-skill',
      storageMode: 'bind-ro',
      fallbackMode: 'control-only',
      files: expect.arrayContaining([expect.objectContaining({ relativePath: 'references/large.bin' })]),
    })]);
    const target = path.join(projectRoot, '.tower', 'skills', 'large-skill');
    expect(fs.existsSync(path.join(target, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'skill.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'scripts', 'run.sh'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'references', 'guide.md'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'references', 'large.bin'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8'))).toMatchObject({
      schemaVersion: 3,
      managedBy: 'tower-project-skill-runtime-layer',
    });
  });

  it('does not use legacy Tower managed source when teamskills source is missing', async () => {
    const home = makeTempDir('tower-project-skill-home-');
    const projectRoot = makeTempDir('tower-project-root-');
    writeLegacyManagedSkill(home, 'legacy-only');

    const { materializeProjectRegistrySkills } = await loadWithHome(home);
    const result = materializeProjectRegistrySkills({
      projectRootPath: projectRoot,
      skillNames: ['legacy-only'],
      now: new Date('2026-06-09T00:00:00.000Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.materialized).toHaveLength(0);
    expect(result.skipped).toEqual([{ name: 'legacy-only', reason: 'not_found_or_disallowed' }]);
    expect(fs.existsSync(path.join(projectRoot, '.tower', 'skills', 'legacy-only'))).toBe(false);
  });

  it('skips unsafe teamskills bundles and does not copy them', async () => {
    const home = makeTempDir('tower-project-skill-home-');
    const projectRoot = makeTempDir('tower-project-root-');
    writeTeamskillsSkill(home, 'unsafe-skill', { '.env': 'TOKEN=value' });

    const { materializeProjectRegistrySkills } = await loadWithHome(home);
    const result = materializeProjectRegistrySkills({
      projectRootPath: projectRoot,
      skillNames: ['unsafe-skill'],
      now: new Date('2026-06-09T00:00:00.000Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.skipped).toEqual([expect.objectContaining({ name: 'unsafe-skill', reason: 'scan_failed' })]);
    expect(result.findings).toEqual([expect.objectContaining({
      name: 'unsafe-skill',
      findings: expect.arrayContaining([expect.objectContaining({ code: 'denied_name', relativePath: '.env' })]),
    })]);
    expect(fs.existsSync(path.join(projectRoot, '.tower', 'skills', 'unsafe-skill'))).toBe(false);
  });

  it('materializes safe bundles while reporting scanner warnings', async () => {
    const home = makeTempDir('tower-project-skill-home-');
    const projectRoot = makeTempDir('tower-project-root-');
    writeTeamskillsSkill(home, 'warning-skill', { 'scripts/__pycache__/run.pyc': 'compiled' });

    const { materializeProjectRegistrySkills } = await loadWithHome(home);
    const result = materializeProjectRegistrySkills({
      projectRootPath: projectRoot,
      skillNames: ['warning-skill'],
      now: new Date('2026-06-09T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.materialized).toHaveLength(1);
    expect(result.findings).toEqual([expect.objectContaining({
      name: 'warning-skill',
      findings: expect.arrayContaining([expect.objectContaining({ code: 'generated_artifact_skipped' })]),
    })]);
    expect(fs.existsSync(path.join(projectRoot, '.tower', 'skills', 'warning-skill', 'scripts', '__pycache__'))).toBe(false);
  });

  it('is idempotent for the same inputs and timestamp', async () => {
    const home = makeTempDir('tower-project-skill-home-');
    const projectRoot = makeTempDir('tower-project-root-');
    writeTeamskillsSkill(home, 'safe-skill');

    const { materializeProjectRegistrySkills } = await loadWithHome(home);
    const opts = {
      projectRootPath: projectRoot,
      skillNames: ['safe-skill'],
      now: new Date('2026-06-09T00:00:00.000Z'),
    };
    const first = materializeProjectRegistrySkills(opts);
    const manifestBefore = fs.readFileSync(first.manifestPath, 'utf-8');
    const second = materializeProjectRegistrySkills(opts);
    const manifestAfter = fs.readFileSync(second.manifestPath, 'utf-8');

    expect(second.ok).toBe(true);
    expect(manifestAfter).toBe(manifestBefore);
  });

  it('prunes only previously managed unrequested skills', async () => {
    const home = makeTempDir('tower-project-skill-home-');
    const projectRoot = makeTempDir('tower-project-root-');
    writeTeamskillsSkill(home, 'keep-skill');
    writeTeamskillsSkill(home, 'old-skill');

    const { materializeProjectRegistrySkills } = await loadWithHome(home);
    materializeProjectRegistrySkills({ projectRootPath: projectRoot, skillNames: ['keep-skill', 'old-skill'] });

    const unmanaged = path.join(projectRoot, '.tower', 'skills', 'manual-folder');
    fs.mkdirSync(unmanaged, { recursive: true });
    fs.writeFileSync(path.join(unmanaged, 'SKILL.md'), '# manual');

    const result = materializeProjectRegistrySkills({ projectRootPath: projectRoot, skillNames: ['keep-skill'] });

    expect(result.pruned).toEqual(['old-skill']);
    expect(fs.existsSync(path.join(projectRoot, '.tower', 'skills', 'old-skill'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.tower', 'skills', 'keep-skill'))).toBe(true);
    expect(fs.existsSync(unmanaged)).toBe(true);
  });
});
