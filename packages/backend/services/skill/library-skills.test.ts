import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-library-skills-'));
  tempDirs.push(dir);
  return dir;
}

function towerRoot(home: string): string {
  return path.join(home, 'tower');
}

function writeTowerSkill(home: string, name: string, description = `Skill ${name}`): string {
  const dir = path.join(towerRoot(home), 'skills', 'managed', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n---\n\n# ${name}\n`);
  return dir;
}

function writeLegacySkill(home: string, name: string, description = `Skill ${name}`): string {
  const dir = path.join(home, '.claude', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n---\n\n# ${name}\n`);
  return dir;
}

function writeTowerCatalog(home: string, fileName: string, body: string): void {
  const dir = path.join(towerRoot(home), 'config', 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), body);
}

function writeLegacyCatalog(home: string, fileName: string, body: string): void {
  const dir = path.join(home, '.claude', 'skills', 'library');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), body);
}

async function loadWithHome(home: string) {
  vi.resetModules();
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return { ...actual, default: { ...actual.default, homedir: () => home }, homedir: () => home };
  });
  return import('./library-skills.ts');
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('os');
  delete process.env.TOWER_ROOT;
  delete process.env.TOWER_MANAGED_SKILLS_DIR;
  delete process.env.TOWER_MANAGED_SKILLS_CATALOG;
  delete process.env.TOWER_LOCAL_SKILLS_CATALOG;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('library-skills managed catalog migration', () => {
  it('loads Tower system/local catalogs first and still merges legacy local fallback', async () => {
    const home = makeTempHome();
    const towerSystemDir = writeTowerSkill(home, 'system-skill', 'System skill');
    const towerLocalDir = writeTowerSkill(home, 'local-skill', 'Local skill');
    const legacyLocalDir = writeLegacySkill(home, 'legacy-local', 'Legacy local skill');

    writeTowerCatalog(home, 'managed-skills.yaml', `library:\n  skills:\n  - name: system-skill\n    owner: moat\n    tier: team\n    version: 1.0.0\n    tags:\n    - core\n`);
    writeTowerCatalog(home, 'local-managed-skills.yaml', `library:\n  skills:\n  - name: local-skill\n    owner: local\n    tier: team\n    version: 1.0.0\n    tags:\n    - customer-local\n`);
    writeLegacyCatalog(home, 'local-library.yaml', `library:\n  skills:\n  - name: legacy-local\n    owner: local\n    tier: team\n    version: 1.0.0\n    tags:\n    - legacy-local\n`);

    const { loadLibrarySkills, getLibrarySkillDirs, getLibrarySkillsDir } = await loadWithHome(home);
    const skills = loadLibrarySkills();
    const names = skills.map((s) => s.name).sort();

    expect(names).toEqual(['legacy-local', 'local-skill', 'system-skill']);
    expect(skills.find((s) => s.name === 'system-skill')).toMatchObject({
      catalog: 'system',
      sourceRoot: towerSystemDir,
      skillPath: path.join(towerSystemDir, 'SKILL.md'),
    });
    expect(skills.find((s) => s.name === 'local-skill')).toMatchObject({
      catalog: 'local',
      sourceRoot: towerLocalDir,
      skillPath: path.join(towerLocalDir, 'SKILL.md'),
    });
    expect(skills.find((s) => s.name === 'legacy-local')).toMatchObject({
      catalog: 'local',
      sourceRoot: legacyLocalDir,
      skillPath: path.join(legacyLocalDir, 'SKILL.md'),
    });
    expect(getLibrarySkillDirs()).toEqual([
      path.join(towerRoot(home), 'skills', 'managed'),
      path.join(home, '.claude', 'skills'),
    ]);
    expect(getLibrarySkillsDir()).toBe(path.join(towerRoot(home), 'skills', 'managed'));
  });

  it('lets Tower system entries win before legacy and does not let local catalogs shadow any system skill', async () => {
    const home = makeTempHome();
    const towerSkillDir = writeTowerSkill(home, 'shared-skill', 'Tower implementation wins');
    writeLegacySkill(home, 'shared-skill', 'Legacy implementation loses');

    writeTowerCatalog(home, 'managed-skills.yaml', `library:\n  skills:\n  - name: shared-skill\n    owner: moat\n    tier: team\n    version: 1.0.0\n    tags:\n    - core\n`);
    writeLegacyCatalog(home, 'library.yaml', `library:\n  skills:\n  - name: shared-skill\n    owner: moat\n    tier: team\n    version: 9.9.9\n    tags:\n    - legacy\n`);
    writeTowerCatalog(home, 'local-managed-skills.yaml', `library:\n  skills:\n  - name: shared-skill\n    owner: local\n    tier: team\n    version: 8.8.8\n    tags:\n    - tower-local\n`);
    writeLegacyCatalog(home, 'local-library.yaml', `library:\n  skills:\n  - name: shared-skill\n    owner: local\n    tier: team\n    version: 7.7.7\n    tags:\n    - legacy-local\n`);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadLibrarySkills } = await loadWithHome(home);
    const skills = loadLibrarySkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'shared-skill',
      version: '1.0.0',
      catalog: 'system',
      sourceRoot: towerSkillDir,
      skillPath: path.join(towerSkillDir, 'SKILL.md'),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('local-managed-skills.yaml entry'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('local-library.yaml entry'));
    warn.mockRestore();
  });

  it('resolves optional source paths from Tower root, directories, and SKILL.md files', async () => {
    const home = makeTempHome();
    const relativeDir = path.join(towerRoot(home), 'custom-sources', 'dir-skill');
    fs.mkdirSync(relativeDir, { recursive: true });
    fs.writeFileSync(path.join(relativeDir, 'SKILL.md'), '---\ndescription: Dir skill\n---\n# dir-skill\n');

    const fileRoot = path.join(home, 'external-source', 'file-skill');
    fs.mkdirSync(fileRoot, { recursive: true });
    fs.writeFileSync(path.join(fileRoot, 'SKILL.md'), '---\ndescription: File skill\n---\n# file-skill\n');

    writeTowerCatalog(home, 'managed-skills.yaml', `library:
  skills:
  - name: dir-skill
    owner: moat
    tier: team
    version: 1.0.0
    source: custom-sources/dir-skill
    tags: [core]
  - name: file-skill
    owner: moat
    tier: team
    version: 1.0.0
    source: ~/external-source/file-skill/SKILL.md
    tags: [core]
`);

    const { loadLibrarySkills } = await loadWithHome(home);
    const skills = loadLibrarySkills();
    const dirSkill = skills.find((s) => s.name === 'dir-skill');
    const fileSkill = skills.find((s) => s.name === 'file-skill');

    expect(dirSkill).toMatchObject({
      sourceRoot: relativeDir,
      skillPath: path.join(relativeDir, 'SKILL.md'),
    });
    expect(fileSkill).toMatchObject({
      sourceRoot: fileRoot,
      skillPath: path.join(fileRoot, 'SKILL.md'),
    });
  });

  it('preserves abstract runtime requirements and portability metadata', async () => {
    const home = makeTempHome();
    writeTowerSkill(home, 'portable-skill', 'Portable skill');
    writeTowerCatalog(home, 'managed-skills.yaml', `library:
  skills:
  - name: portable-skill
    owner: moat
    tier: team
    version: 1.0.0
    visibility: public
    tags: [core]
    runtime_requirements:
      execution: required
      persistence: long_running_optional
      network: optional
      secrets: [CRM_API_KEY]
      packages:
      - pandas
    portability:
      level: portable
      warnings:
      - pre-existing warning
    access: [everyone, user:admin]
    distribution:
      audience: customer-admin
      profiles: [managed, full]
      customer_safe: true
`);

    const { loadLibrarySkills } = await loadWithHome(home);
    const skill = loadLibrarySkills()[0];
    expect(skill.visibility).toBe('public');
    expect(skill.runtimeRequirements).toEqual({
      execution: 'required',
      persistence: 'long_running_optional',
      network: 'optional',
      secrets: ['CRM_API_KEY'],
      packages: ['pandas'],
    });
    expect(skill.portability).toEqual({ level: 'portable', warnings: ['pre-existing warning'] });
    expect(skill.distribution).toEqual({ audience: 'customer-admin', profiles: ['managed', 'full'], customerSafe: true });
    expect(skill.access).toEqual(['everyone', 'user:admin']);
  });

  it('parses nested YAML objects for runtime requirements, distribution, and access', async () => {
    const home = makeTempHome();
    writeTowerSkill(home, 'nested-object-skill', 'Nested object skill');
    writeTowerCatalog(home, 'managed-skills.yaml', `library:
  skills:
    - name: nested-object-skill
      owner: moat
      tier: workspace-admin
      version: 2.1.0
      visibility: operator
      tags:
        - core
        - admin
      runtime_requirements:
        execution: optional
        persistence: long_running_required
        network: required
        secrets:
          - CRM_API_KEY
          - HUBSPOT_TOKEN
        packages:
          - pandas
          - playwright
      distribution:
        audience: operator
        profiles:
          - managed
          - standalone
        customer_safe: false
      portability:
        level: environment-bound
        warnings:
          - Needs tenant-specific setup
      access:
        - everyone
        - user:admin
        - group:operators
`);

    const { loadLibrarySkills } = await loadWithHome(home);
    const skill = loadLibrarySkills()[0];

    expect(skill).toMatchObject({
      name: 'nested-object-skill',
      tier: 'workspace-admin',
      visibility: 'hidden',
      tags: ['core', 'admin'],
      runtimeRequirements: {
        execution: 'optional',
        persistence: 'long_running_required',
        network: 'required',
        secrets: ['CRM_API_KEY', 'HUBSPOT_TOKEN'],
        packages: ['pandas', 'playwright'],
      },
      distribution: {
        audience: 'operator',
        profiles: ['managed', 'standalone'],
        customerSafe: false,
      },
      portability: {
        level: 'environment-bound',
        warnings: ['Needs tenant-specific setup'],
      },
      access: ['everyone', 'user:admin', 'group:operators'],
    });
  });

  it('falls back to legacy catalog/source when no Tower managed catalog exists', async () => {
    const home = makeTempHome();
    const legacyDir = writeLegacySkill(home, 'bad-portable', 'Bad portable');
    fs.appendFileSync(path.join(legacyDir, 'SKILL.md'), '\nRun with mcp__sandbox__run and create workspace/published/sites/foo.\n');
    writeLegacyCatalog(home, 'library.yaml', `library:
  skills:
  - name: bad-portable
    owner: moat
    tier: team
    version: 1.0.0
    tags: [core]
`);

    const { loadLibrarySkills, getLibrarySkillDirs, getLibrarySkillsDir } = await loadWithHome(home);
    const skill = loadLibrarySkills()[0];
    const warnings = skill.portability?.warnings ?? [];

    expect(skill.sourceRoot).toBe(legacyDir);
    expect(getLibrarySkillDirs()).toEqual([path.join(home, '.claude', 'skills')]);
    expect(getLibrarySkillsDir()).toBe(path.join(home, '.claude', 'skills'));
    expect(warnings.some((w) => w.includes('mcp__sandbox__run'))).toBe(true);
    expect(warnings.some((w) => w.includes('publishing'))).toBe(true);
  });
});
