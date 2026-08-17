import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-skill-bundle-resolver-'));
  tempDirs.push(dir);
  return dir;
}

function towerRoot(home: string): string {
  return path.join(home, 'tower');
}

function writeTowerCatalog(home: string, body: string): void {
  const dir = path.join(towerRoot(home), 'config', 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'managed-skills.yaml'), body);
}

function writeTowerSkill(home: string, name: string, content?: string): string {
  const dir = path.join(towerRoot(home), 'skills', 'managed', name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content ?? `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`);
  fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/usr/bin/env bash\necho ok\n');
  return dir;
}

function writeTeamskillsSkill(home: string, name: string, content?: string): string {
  const dir = path.join(home, 'workspace', 'projects', 'teamskills', 'skills', name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content ?? `---\nname: ${name}\ndescription: org ${name}\nversion: 9.9.9\n---\n\n# org ${name}\n`);
  fs.writeFileSync(path.join(dir, 'skill.yaml'), `name: ${name}\nversion: 9.9.9\nrequiredSecrets:\n- ORG_TOKEN\n`);
  fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/usr/bin/env bash\necho org\n');
  return dir;
}

async function loadWithHome(home: string) {
  vi.resetModules();
  process.env.TEAMSKILLS_PROJECT_ROOT = path.join(home, 'workspace', 'projects', 'teamskills');
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return { ...actual, default: { ...actual.default, homedir: () => home }, homedir: () => home };
  });
  return import('./skill-bundle-resolver.ts');
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('os');
  delete process.env.TOWER_ROOT;
  delete process.env.TOWER_MANAGED_SKILLS_DIR;
  delete process.env.TOWER_MANAGED_SKILLS_CATALOG;
  delete process.env.TOWER_LOCAL_SKILLS_CATALOG;
  delete process.env.TEAMSKILLS_PROJECT_ROOT;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('skill-bundle-resolver', () => {
  it('resolves teamskills organization source into internal bundle metadata', async () => {
    const home = makeTempHome();
    const orgDir = writeTeamskillsSkill(home, 'shared-skill');

    const { resolveRegistrySkillBundle } = await loadWithHome(home);
    const bundle = resolveRegistrySkillBundle('shared-skill');

    expect(bundle?.sourceKind).toBe('teamskills');
    expect(bundle?.catalog).toBe('teamskills');
    expect(bundle?.ownership).toBe('org');
    expect(bundle?.version).toBe('9.9.9');
    expect(bundle?.requiredSecrets).toEqual(['ORG_TOKEN']);
    expect(bundle?.sourceProject).toBe('teamskills');
    expect(bundle?.sourcePath).toBe('skills/shared-skill');
    expect(bundle?.origin).toBe('org');
    expect(bundle?.canonicalId).toBe('tower://org/teamskills/shared-skill');
    expect(bundle?.bundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(bundle?.sourceCommit).toBeUndefined();
    expect(bundle?.rootPath).toBe(orgDir);
    expect(bundle?.skillPath).toBe(path.join(orgDir, 'SKILL.md'));
    expect(bundle?.files.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', 'scripts/run.sh', 'skill.yaml']);
    expect(bundle?.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resolves best-effort source commit from a parent git worktree', async () => {
    const home = makeTempHome();
    const teamskillsRoot = path.join(home, 'workspace', 'projects', 'teamskills');
    const gitDir = path.join(teamskillsRoot, '.git');
    const commit = '1234567890abcdef1234567890abcdef12345678';
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), `${commit}\n`);
    writeTeamskillsSkill(home, 'versioned-skill');

    const { resolveRegistrySkillBundle } = await loadWithHome(home);
    const bundle = resolveRegistrySkillBundle('versioned-skill');

    expect(bundle?.sourceCommit).toBe(commit);
  });

  it('excludes generated artifacts from teamskills bundle metadata and digest', async () => {
    const home = makeTempHome();
    const orgDir = writeTeamskillsSkill(home, 'polluted-skill');
    fs.mkdirSync(path.join(orgDir, 'scripts', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(orgDir, 'scripts', '__pycache__', 'wiki.cpython-310.pyc'), 'compiled');
    fs.mkdirSync(path.join(orgDir, '.pytest_cache'), { recursive: true });
    fs.writeFileSync(path.join(orgDir, '.pytest_cache', 'README.md'), 'cache');

    const { resolveRegistrySkillBundle } = await loadWithHome(home);
    const polluted = resolveRegistrySkillBundle('polluted-skill');
    fs.rmSync(path.join(orgDir, 'scripts', '__pycache__'), { recursive: true, force: true });
    fs.rmSync(path.join(orgDir, '.pytest_cache'), { recursive: true, force: true });
    const clean = resolveRegistrySkillBundle('polluted-skill');

    expect(polluted?.files.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', 'scripts/run.sh', 'skill.yaml']);
    expect(polluted?.bundleDigest).toBe(clean?.bundleDigest);
  });

  it('does not fall back to legacy Tower managed source when teamskills source is missing', async () => {
    const home = makeTempHome();
    writeTowerSkill(home, 'youtube-transcript');
    writeTowerCatalog(home, `library:
  skills:
  - name: youtube-transcript
    owner: moat
    tier: team
    version: 0.2.2
    visibility: default
    tags: [managed]
    runtime_requirements:
      secrets: [APIFY_TOKEN]
`);

    const { resolveRegistrySkillBundle } = await loadWithHome(home);
    expect(resolveRegistrySkillBundle('youtube-transcript')).toBeNull();
  });

  it('ignores includeHidden compatibility flag without using legacy catalog fallback', async () => {
    const home = makeTempHome();
    writeTowerSkill(home, 'ops-only');
    writeTowerCatalog(home, `library:
  skills:
  - name: ops-only
    owner: moat
    tier: team
    version: 1.0.0
    visibility: hidden
    tags: [ops]
`);

    const { resolveRegistrySkillBundle } = await loadWithHome(home);
    expect(resolveRegistrySkillBundle('ops-only')).toBeNull();
    expect(resolveRegistrySkillBundle('ops-only', { includeHidden: true })).toBeNull();
  });
});
