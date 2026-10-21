import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-skill-registry-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.TOWER_SYSTEM_SKILLS_DIR;
  delete process.env.TEAMSKILLS_PROJECT_ROOT;
  delete process.env.WORKSPACE_ROOT;
  vi.resetModules();
  vi.doUnmock('./library-skills.js');
  vi.doUnmock('./teamskills-source.js');
  vi.doUnmock('./skill-bundle-resolver.js');
  vi.doUnmock('../../db/pg-repo.js');
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('skill-registry company sharing', () => {
  it('exposes explicitly linked developer skills without leaking global fleet skills', async () => {
    const workspace = makeTempDir();
    const projectRoot = path.join(workspace, 'projects', 'developer');
    const native = path.join(projectRoot, 'skills');
    const system = path.join(workspace, 'system');
    const names = ['commit-session', 'checkpoint', 'wip', 'ready', 'skill-registry'];
    fs.mkdirSync(path.join(projectRoot, '.tower', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.tower', 'skills', 'manifest.json'), JSON.stringify({ skills: [] }));
    for (const name of [...names, 'fleet']) {
      const source = path.join(system, name);
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Developer helper\n---\n# ${name}\n`);
      if (name === 'fleet') continue;
      const target = path.join(native, name);
      fs.mkdirSync(target, { recursive: true });
      fs.symlinkSync(path.join(source, 'SKILL.md'), path.join(target, 'SKILL.md'));
    }
    vi.resetModules();
    vi.doMock('../../config.js', () => ({ config: { dataDir: path.join(workspace, 'data'), towerRole: 'full' } }));
    vi.doMock('../../db/pg-repo.js', () => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => null), execute: vi.fn(async () => undefined) }));
    vi.doMock('./library-skills.js', () => ({ loadLibrarySkills: () => [], getLibrarySkill: () => null, getLibrarySkillDirs: () => [system], getLibrarySkillsDir: () => system }));
    const registry = await import('./skill-registry.ts');
    const visible = await registry.getSkillsForSession(1, null, 'admin', projectRoot);
    for (const name of names) {
      expect(visible.map(s => s.name)).toContain(name);
      await expect(registry.getSkillByName(name, 1, null, 'admin', projectRoot)).resolves.toMatchObject({ scope: 'project', content: expect.stringContaining('# ' + name) });
    }
    const commands = await registry.getCommandsForUser(1, null, 'admin', projectRoot);
    for (const name of names) expect(commands.map(c => c.name)).toContain('/' + name);
    expect(visible.map(s => s.name)).not.toContain('fleet');
    expect(registry.getProjectSkillPaths(projectRoot)).toEqual([native]);
    await expect(registry.getSkillByName('fleet', 1, null, 'admin', projectRoot)).resolves.toBeNull();
  });

  it('creates the filesystem-only teamskills store when no teamskills project has been seeded', async () => {
    const workspace = makeTempDir();
    const projectRoot = path.join(workspace, 'projects', 'authoring');
    const teamskillsRoot = path.join(workspace, 'projects', 'teamskills');
    const sourceDir = path.join(projectRoot, 'skills', 'fresh-company-skill');
    const sourceSkill = path.join(sourceDir, 'SKILL.md');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourceSkill, '---\ndescription: Fresh company skill\n---\n# Fresh\n', 'utf-8');
    process.env.WORKSPACE_ROOT = workspace;
    process.env.TEAMSKILLS_PROJECT_ROOT = teamskillsRoot;

    vi.resetModules();
    vi.doMock('../../config.js', () => ({ config: { dataDir: path.join(workspace, 'data'), towerRole: 'full' } }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [],
      getLibrarySkillsDir: () => path.join(workspace, 'library-skills'),
    }));
    const registry = await import('./skill-registry.ts');
    const id = `project-fs:${Buffer.from(sourceSkill).toString('base64url')}`;

    await expect(registry.shareProjectSkillToCompany(id)).resolves.toMatchObject({
      created: true,
      skillsetUpdated: true,
      skill: { name: 'fresh-company-skill', scope: 'company' },
    });
    expect(fs.readFileSync(path.join(teamskillsRoot, 'skills', 'fresh-company-skill', 'SKILL.md'), 'utf8')).toContain('# Fresh');
    expect(JSON.parse(fs.readFileSync(path.join(teamskillsRoot, 'skillset.json'), 'utf8')).defaultSkills).toContain('fresh-company-skill');
  });
});

describe('skill-registry project skill paths', () => {
  it('uses project skills first, then manifest-listed managed skills when project manifest exists', async () => {
    const { getProjectSkillPaths } = await import('./skill-registry.ts');
    const root = makeTempDir();
    const managedSkillDir = path.join(root, '.tower', 'skills', 'managed-helper');
    const staleManagedSkillDir = path.join(root, '.tower', 'skills', 'stale-helper');
    const nativeDir = path.join(root, 'skills');
    const piDir = path.join(root, '.pi', 'skills');
    const agentsDir = path.join(root, '.agents', 'skills');
    const claudeDir = path.join(root, '.claude', 'skills');
    for (const dir of [managedSkillDir, staleManagedSkillDir, nativeDir, piDir, agentsDir, claudeDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(root, '.tower', 'skills', 'manifest.json'), JSON.stringify({ schemaVersion: 1, skills: [{ name: 'managed-helper' }] }), 'utf-8');

    expect(getProjectSkillPaths(root)).toEqual([nativeDir, managedSkillDir]);
  });

  it('returns empty array when no project skill path exists', async () => {
    const { getProjectSkillPaths } = await import('./skill-registry.ts');
    const root = makeTempDir();
    expect(getProjectSkillPaths(root)).toEqual([]);
  });
});

describe('skill-registry materialized skill path adapter', () => {
  async function loadWithDataDir(dataDir: string, libraryDir: string) {
    vi.resetModules();
    vi.doMock('../../config.js', () => ({
      config: { dataDir, towerRole: 'full' },
    }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [libraryDir],
      getLibrarySkillsDir: () => libraryDir,
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    return import('./skill-registry.ts');
  }

  it('falls back to legacy global paths but omits personal paths when no project managed manifest exists', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'library-skills');
    const personalDir = path.join(dataDir, 'skills', 'personal', '42');
    const projectRoot = makeTempDir();
    const projectSkillsDir = path.join(projectRoot, 'skills');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(personalDir, { recursive: true });
    fs.mkdirSync(projectSkillsDir, { recursive: true });

    const registry = await loadWithDataDir(dataDir, libraryDir);

    await expect(registry.getMaterializedSkillPaths({
      runtime: 'pi',
      userId: 42,
      projectId: 'project-1',
      cwd: projectRoot,
      username: 'admin',
    })).resolves.toEqual([libraryDir, projectSkillsDir]);
  });

  it('uses project skills first, then .tower/skills when managed manifest exists', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'library-skills');
    const personalDir = path.join(dataDir, 'skills', 'personal', '42');
    const projectRoot = makeTempDir();
    const managedSkillsDir = path.join(projectRoot, '.tower', 'skills');
    const projectSkillsDir = path.join(projectRoot, 'skills');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(personalDir, { recursive: true });
    fs.mkdirSync(managedSkillsDir, { recursive: true });
    fs.mkdirSync(projectSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(managedSkillsDir, 'manifest.json'), '{"schemaVersion":1,"skills":[{"name":"managed-helper"}]}\n', 'utf-8');
    const managedSkillDir = path.join(managedSkillsDir, 'managed-helper');
    fs.mkdirSync(managedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(managedSkillDir, 'SKILL.md'), '---\ndescription: Managed helper\n---\n# managed\n', 'utf-8');

    const registry = await loadWithDataDir(dataDir, libraryDir);

    await expect(registry.getMaterializedSkillPaths({
      runtime: 'pi',
      userId: 42,
      projectId: 'project-1',
      cwd: projectRoot,
      username: 'admin',
    })).resolves.toEqual([projectSkillsDir, managedSkillDir]);
  });

  it('deduplicates compatibility paths', async () => {
    const dataDir = makeTempDir();
    const projectRoot = makeTempDir();
    const projectSkillsDir = path.join(projectRoot, 'skills');
    fs.mkdirSync(projectSkillsDir, { recursive: true });

    const registry = await loadWithDataDir(dataDir, projectSkillsDir);

    await expect(registry.getMaterializedSkillPaths({ runtime: 'pi', cwd: projectRoot }))
      .resolves.toEqual([projectSkillsDir]);
  });

  it('does not materialize DB project rows into project skills folders anymore', async () => {
    const dataDir = makeTempDir();
    const projectRoot = makeTempDir();
    const manualSkill = path.join(projectRoot, 'skills', 'manual-helper');
    fs.mkdirSync(manualSkill, { recursive: true });
    fs.writeFileSync(path.join(manualSkill, 'SKILL.md'), '# manual\n', 'utf-8');

    vi.resetModules();
    vi.doMock('../../config.js', () => ({ config: { dataDir, towerRole: 'full' } }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [path.join(dataDir, 'library-skills')],
      getLibrarySkillsDir: () => path.join(dataDir, 'library-skills'),
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([{ name: 'db-helper', content: '# db\n' }])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    const registry = await import('./skill-registry.ts');

    await registry.syncProjectSkillsToFs('project-1', projectRoot);

    expect(fs.existsSync(path.join(projectRoot, 'skills', 'manual-helper', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'skills', 'db-helper'))).toBe(false);
  });

  it('loads project filesystem skills from managed path before native/Pi/Agent/legacy paths', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'library-skills');
    const projectRoot = makeTempDir();
    const managedRoot = path.join(projectRoot, '.tower', 'skills');
    const managedSkill = path.join(managedRoot, 'shared-helper');
    const nativeSkill = path.join(projectRoot, 'skills', 'shared-helper');
    const staleDbSkill = path.join(projectRoot, 'skills', 'stale-db-helper');
    const piSkill = path.join(projectRoot, '.pi', 'skills', 'pi-helper');
    const legacySkill = path.join(projectRoot, '.claude', 'skills', 'shared-helper');
    fs.mkdirSync(managedSkill, { recursive: true });
    fs.mkdirSync(nativeSkill, { recursive: true });
    fs.mkdirSync(staleDbSkill, { recursive: true });
    fs.mkdirSync(piSkill, { recursive: true });
    fs.mkdirSync(legacySkill, { recursive: true });
    fs.writeFileSync(path.join(managedRoot, 'manifest.json'), '{"schemaVersion":1,"skills":[{"name":"shared-helper"}]}\n', 'utf-8');
    fs.writeFileSync(path.join(managedSkill, 'SKILL.md'), '---\ndescription: Managed helper\n---\n# managed\n', 'utf-8');
    fs.writeFileSync(path.join(nativeSkill, 'SKILL.md'), '---\ndescription: Native helper\n---\n# native\n', 'utf-8');
    fs.writeFileSync(path.join(staleDbSkill, 'SKILL.md'), '---\ndescription: Stale DB helper\n---\n# stale\n', 'utf-8');
    fs.writeFileSync(path.join(staleDbSkill, '.tower-db-managed'), 'managed-by=tower-skill-registry\n', 'utf-8');
    fs.writeFileSync(path.join(piSkill, 'SKILL.md'), '---\ndescription: Pi helper\n---\n# pi\n', 'utf-8');
    fs.writeFileSync(path.join(legacySkill, 'SKILL.md'), '---\ndescription: Legacy helper\n---\n# legacy\n', 'utf-8');

    const registry = await loadWithDataDir(dataDir, libraryDir);
    const skills = await registry.getSkillsForSession(undefined, 'project-1', null, projectRoot);

    expect(skills.map((s) => s.name)).toEqual(['shared-helper']);
    expect(skills.find((s) => s.name === 'shared-helper')?.description).toBe('Native helper');
  });

  it('exposes project-local skills as slash commands without requiring a managed manifest', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'library-skills');
    const projectRoot = makeTempDir();
    const skillDir = path.join(projectRoot, 'skills', 'fresh-local');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
description: Fresh local skill
---
# fresh local
`, 'utf-8');

    vi.resetModules();
    vi.doMock('../../config.js', () => ({ config: { dataDir, towerRole: 'full' } }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [libraryDir],
      getLibrarySkillsDir: () => libraryDir,
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    const registry = await import('./skill-registry.ts');

    expect(fs.existsSync(path.join(projectRoot, '.tower', 'skills', 'manifest.json'))).toBe(false);
    await expect(registry.getCommandsForUser(1, 'project-1', 'member', projectRoot).then((commands: any[]) => commands.find((c) => c.name === '/fresh-local')))
      .resolves.toMatchObject({
        name: '/fresh-local',
        scope: 'project',
        dispatch: { type: 'skill', target: 'fresh-local' },
      });
  });

  it('exposes root commands and rejects a project skill with the same slash name', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'library-skills');
    const projectRoot = makeTempDir();
    const commandsDir = path.join(projectRoot, 'commands');
    const skillDir = path.join(projectRoot, 'skills', 'review');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'review.command.yaml'), `id: review\ncanonical: /review\ndisplayName: 빠른 리뷰\ndescription: 정해진 리뷰 workflow를 실행합니다.\ndispatch:\n  target: review.run\n`, 'utf-8');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\ndescription: AI가 검토하는 동명 스킬\n---\n# Review\n`, 'utf-8');

    vi.resetModules();
    vi.doMock('../../config.js', () => ({ config: { dataDir, towerRole: 'full' } }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [libraryDir],
      getLibrarySkillsDir: () => libraryDir,
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    const registry = await import('./skill-registry.ts');

    const commands = await registry.getCommandsForUser(1, 'project-1', 'member', projectRoot);
    expect(commands.filter((command: any) => command.canonical === '/review')).toHaveLength(1);
    expect(commands.find((command: any) => command.canonical === '/review')).toMatchObject({
      kind: 'workflow',
      source: 'workflow',
      scope: 'project',
      dispatch: { type: 'workflow', target: 'review.run' },
    });
  });

  it('keeps native slash commands ahead of colliding project definitions', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'library-skills');
    const projectRoot = makeTempDir();
    const commandsDir = path.join(projectRoot, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'skills.command.yaml'), `id: local-skills\ncanonical: /skills\ndescription: Native command collision\ndispatch:\n  target: local.skills\n`, 'utf-8');

    vi.resetModules();
    vi.doMock('../../config.js', () => ({ config: { dataDir, towerRole: 'full' } }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [libraryDir],
      getLibrarySkillsDir: () => libraryDir,
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    const registry = await import('./skill-registry.ts');

    const commands = await registry.getCommandsForUser(1, 'project-1', 'member', projectRoot);
    expect(commands.filter((command: any) => command.canonical === '/skills')).toHaveLength(1);
    expect(commands.find((command: any) => command.canonical === '/skills')).toMatchObject({
      id: 'native:skills',
      kind: 'native',
    });
  });

  it('uses project skills plus manifest-listed managed skills and blocks legacy/global fallback', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'library-skills');
    const projectRoot = makeTempDir();
    const managedRoot = path.join(projectRoot, '.tower', 'skills');
    const managedSkill = path.join(managedRoot, 'managed-helper');
    const localSkill = path.join(projectRoot, 'skills', 'local-helper');
    const legacySkill = path.join(projectRoot, '.claude', 'skills', 'offer-A4-html');
    fs.mkdirSync(managedSkill, { recursive: true });
    fs.mkdirSync(localSkill, { recursive: true });
    fs.mkdirSync(legacySkill, { recursive: true });
    fs.writeFileSync(path.join(managedRoot, 'manifest.json'), '{"schemaVersion":1,"skills":[{"name":"managed-helper"}]}\n', 'utf-8');
    fs.writeFileSync(path.join(managedSkill, 'SKILL.md'), '---\ndescription: Managed helper\n---\n# managed\n', 'utf-8');
    fs.writeFileSync(path.join(localSkill, 'SKILL.md'), '---\ndescription: Local helper\n---\n# local\n', 'utf-8');
    fs.writeFileSync(path.join(legacySkill, 'SKILL.md'), '---\ndescription: Legacy offer\n---\n# legacy offer\n', 'utf-8');

    vi.resetModules();
    vi.doMock('../../config.js', () => ({ config: { dataDir, towerRole: 'full' } }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: (name: string) => name === 'offer-A4-html'
        ? {
          name,
          description: 'Legacy global offer',
          content: '# global offer',
          visibility: 'default',
          catalog: 'system',
          skillPath: path.join(libraryDir, name, 'SKILL.md'),
          tags: [],
        }
        : null,
      getLibrarySkillDirs: () => [libraryDir],
      getLibrarySkillsDir: () => libraryDir,
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    const registry = await import('./skill-registry.ts');

    expect(registry.getProjectSkillPaths(projectRoot)).toEqual([path.join(projectRoot, 'skills'), managedSkill]);
    await expect(registry.getSkillByName('local-helper', 1, 'project-1', 'member', projectRoot))
      .resolves.toMatchObject({ scope: 'project' });
    await expect(registry.getSkillByName('managed-helper', 1, 'project-1', 'member', projectRoot))
      .resolves.toMatchObject({ scope: 'project' });
    await expect(registry.getSkillByName('offer-A4-html', 1, 'project-1', 'member', projectRoot))
      .resolves.toBeNull();
  });

  it('omits global library skills from session skills and slash commands when project managed manifest exists', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'library-skills');
    const projectRoot = makeTempDir();
    const managedRoot = path.join(projectRoot, '.tower', 'skills');
    const managedSkill = path.join(managedRoot, 'managed-helper');
    fs.mkdirSync(managedSkill, { recursive: true });
    fs.writeFileSync(path.join(managedRoot, 'manifest.json'), '{"schemaVersion":1,"skills":[{"name":"managed-helper"}]}\n', 'utf-8');
    fs.writeFileSync(path.join(managedSkill, 'SKILL.md'), '---\ndescription: Managed helper\n---\n# managed\n', 'utf-8');

    vi.resetModules();
    vi.doMock('../../config.js', () => ({ config: { dataDir, towerRole: 'full' } }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [{
        id: 'global-helper',
        name: 'global-helper',
        scope: 'company',
        description: 'Global helper',
        category: 'general',
        content: '# global',
        enabled: true,
        visibility: 'default',
        source: 'library',
        catalog: 'system',
        ownership: 'system',
        version: '1.0.0',
        skillPath: path.join(libraryDir, 'global-helper', 'SKILL.md'),
        access: ['everyone'],
        tags: [],
      }],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [libraryDir],
      getLibrarySkillsDir: () => libraryDir,
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    const registry = await import('./skill-registry.ts');

    await expect(registry.getSkillsForSession(1, 'project-1', 'member', projectRoot).then((skills: any[]) => skills.map((s) => s.name)))
      .resolves.toEqual(['managed-helper']);
    await expect(registry.getCommandsForUser(1, 'project-1', 'member', projectRoot).then((commands: any[]) => commands.map((c) => c.name)))
      .resolves.toEqual(['/agent', '/skills', '/task list', '/compact', '/managed-helper']);
  });

  it('exposes command aliases and first-class metadata for project skills', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'library-skills');
    const projectRoot = makeTempDir();
    const skillDir = path.join(projectRoot, 'skills', 'meeting-prep');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
description: Meeting prep
display-name: 회의 준비
argument-hint: "[캘린더]"
slash-aliases:
  - /회의준비
  - /회의_준비
---
# meeting
`, 'utf-8');

    vi.resetModules();
    vi.doMock('../../config.js', () => ({ config: { dataDir, towerRole: 'full' } }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [libraryDir],
      getLibrarySkillsDir: () => libraryDir,
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    const registry = await import('./skill-registry.ts');

    await expect(registry.getCommandsForUser(1, 'project-1', 'member', projectRoot).then((commands: any[]) => commands.find((c) => c.name === '/meeting-prep')))
      .resolves.toMatchObject({
        id: 'meeting-prep',
        kind: 'skill',
        canonical: '/meeting-prep',
        name: '/meeting-prep',
        aliases: ['/meeting-prep', '/회의 준비', '/회의준비', '/회의_준비'],
        displayName: '회의 준비',
        argumentHint: '[캘린더]',
        source: 'skills',
        scope: 'project',
        risk: 'medium',
        dispatch: { type: 'skill', target: 'meeting-prep' },
      });
  });

  it('materializes git-tracked system skill sources for Pi while retaining legacy company fallback', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'legacy-library-skills');
    const sourceRoot = makeTempDir();
    const sourceSkill = path.join(sourceRoot, 'source-helper');
    fs.mkdirSync(path.join(sourceSkill, 'scripts', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(sourceSkill, 'SKILL.md'), '# source-helper\n', 'utf-8');
    fs.writeFileSync(path.join(sourceSkill, 'scripts', 'run.py'), 'print("ok")\n', 'utf-8');
    fs.writeFileSync(path.join(sourceSkill, 'scripts', '__pycache__', 'run.pyc'), 'compiled', 'utf-8');
    process.env.TOWER_SYSTEM_SKILLS_DIR = sourceRoot;

    const registry = await loadWithDataDir(dataDir, libraryDir);
    const piSystemDir = path.join(dataDir, 'runtime-skills', 'pi', 'system');

    await expect(registry.getMaterializedSkillPaths({ runtime: 'pi' }))
      .resolves.toEqual([piSystemDir, libraryDir]);
    expect(fs.existsSync(path.join(piSystemDir, 'source-helper', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(piSystemDir, 'source-helper', 'scripts', 'run.py'))).toBe(true);
    expect(fs.existsSync(path.join(piSystemDir, 'source-helper', 'scripts', '__pycache__'))).toBe(false);
  });

  it('keeps Claude runtime on legacy company paths when no project managed manifest exists', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'legacy-library-skills');
    const sourceRoot = makeTempDir();
    fs.mkdirSync(path.join(sourceRoot, 'source-helper'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'source-helper', 'SKILL.md'), '# source-helper\n', 'utf-8');
    process.env.TOWER_SYSTEM_SKILLS_DIR = sourceRoot;

    const registry = await loadWithDataDir(dataDir, libraryDir);

    await expect(registry.getMaterializedSkillPaths({ runtime: 'claude' }))
      .resolves.toEqual([libraryDir]);
  });

  it('omits Claude runtime legacy company paths but keeps project skills when project managed manifest exists', async () => {
    const dataDir = makeTempDir();
    const libraryDir = path.join(dataDir, 'legacy-library-skills');
    const projectRoot = makeTempDir();
    const managedRoot = path.join(projectRoot, '.tower', 'skills');
    const managedSkill = path.join(managedRoot, 'managed-helper');
    const projectSkillsDir = path.join(projectRoot, 'skills');
    fs.mkdirSync(managedSkill, { recursive: true });
    fs.mkdirSync(projectSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(managedRoot, 'manifest.json'), '{"schemaVersion":1,"skills":[{"name":"managed-helper"}]}\n', 'utf-8');
    fs.writeFileSync(path.join(managedSkill, 'SKILL.md'), '# managed-helper\n', 'utf-8');

    const registry = await loadWithDataDir(dataDir, libraryDir);

    await expect(registry.getMaterializedSkillPaths({ runtime: 'claude', cwd: projectRoot }))
      .resolves.toEqual([projectSkillsDir, managedSkill]);
  });
});

describe('skill-registry createSkill guards', () => {
  async function loadCreateSkillWithMocks() {
    vi.resetModules();
    const dataDir = makeTempDir();
    const executeMock = vi.fn(() => Promise.resolve(undefined));
    vi.doMock('../../config.js', () => ({
      config: { dataDir, towerRole: 'full' },
    }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [path.join(dataDir, 'library-skills')],
      getLibrarySkillsDir: () => path.join(dataDir, 'library-skills'),
    }));
    vi.doMock('./skill-credential.js', () => ({
      syncSkillProviders: vi.fn(() => Promise.resolve(undefined)),
      reconcileSkillProviders: vi.fn(() => Promise.resolve(undefined)),
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: executeMock,
    }));
    const registry = await import('./skill-registry.ts');
    return { registry, executeMock };
  }

  it('refuses personal skill creation because personal skills are deprecated', async () => {
    const { registry, executeMock } = await loadCreateSkillWithMocks();

    await expect(registry.createSkill({
      name: 'my-helper',
      scope: 'personal',
      content: '# my-helper',
    })).rejects.toThrow('Personal skills are deprecated');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('creates project skills as filesystem source without DB insert', async () => {
    vi.resetModules();
    const dataDir = makeTempDir();
    const projectRoot = makeTempDir();
    const executeMock = vi.fn(() => Promise.resolve(undefined));
    vi.doMock('../../config.js', () => ({ config: { dataDir, towerRole: 'full' } }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => [],
      getLibrarySkill: () => null,
      getLibrarySkillDirs: () => [path.join(dataDir, 'library-skills')],
      getLibrarySkillsDir: () => path.join(dataDir, 'library-skills'),
    }));
    vi.doMock('./skill-credential.js', () => ({
      syncSkillProviders: vi.fn(() => Promise.resolve(undefined)),
      reconcileSkillProviders: vi.fn(() => Promise.resolve(undefined)),
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn(() => Promise.resolve([])),
      queryOne: vi.fn(() => Promise.resolve({ root_path: projectRoot })),
      execute: executeMock,
    }));
    const registry = await import('./skill-registry.ts');

    const skill = await registry.createSkill({
      name: 'project-helper',
      scope: 'project',
      projectId: 'project-1',
      content: '---\ndescription: Project helper\n---\n# project-helper\n',
    });

    expect(skill.name).toBe('project-helper');
    expect(skill.source).toBe('project-fs');
    expect(fs.existsSync(path.join(projectRoot, 'skills', 'project-helper', 'SKILL.md'))).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('refuses project skills without projectId', async () => {
    const { registry, executeMock } = await loadCreateSkillWithMocks();

    await expect(registry.createSkill({
      name: 'project-helper',
      scope: 'project',
      content: '# project-helper',
    })).rejects.toThrow('projectId required for project skill');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('refuses invalid scopes before writing to the registry', async () => {
    const { registry, executeMock } = await loadCreateSkillWithMocks();

    await expect(registry.createSkill({
      name: 'bad-helper',
      scope: 'workspace' as any,
      content: '# bad-helper',
    })).rejects.toThrow('Invalid skill scope');
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('skill-registry prompt visibility filtering', () => {
  async function loadWithLibrarySkills(skills: any[], prefs: Array<{ skill_name: string; enabled: number }> = [], towerRole = 'full') {
    vi.resetModules();
    const dataDir = makeTempDir();
    const teamskillsDir = path.join(dataDir, 'teamskills');
    for (const s of skills) {
      const dir = path.join(teamskillsDir, s.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.content}`, 'utf-8');
    }
    vi.doMock('../../config.js', () => ({
      config: { dataDir, towerRole },
    }));
    vi.doMock('./library-skills.js', () => ({
      loadLibrarySkills: () => skills,
      getLibrarySkill: (name: string) => skills.find((s) => s.name === name) ?? null,
      getLibrarySkillDirs: () => ['/tmp/skills'],
      getLibrarySkillsDir: () => '/tmp/skills',
    }));
    vi.doMock('./teamskills-source.js', () => ({
      readTeamskillsSkillset: () => skills.filter((s) => s.visibility !== 'hidden').map((s) => s.name),
    }));
    vi.doMock('./skill-bundle-resolver.js', () => ({
      resolveRegistrySkillBundle: (name: string) => {
        const s = skills.find((item) => item.name === name);
        if (!s || s.visibility === 'hidden') return null;
        const rootPath = path.join(teamskillsDir, name);
        return {
          name,
          version: s.version,
          sourceKind: 'teamskills',
          catalog: 'teamskills',
          visibility: s.visibility,
          ownership: 'org',
          rootPath,
          skillPath: path.join(rootPath, 'SKILL.md'),
          requiredSecrets: [],
          sourceProject: 'teamskills',
          sourcePath: `skills/${name}`,
          origin: 'org',
          runtimeRequirements: s.runtimeRequirements,
          portability: s.portability,
          access: s.access,
          files: [],
        };
      },
    }));
    vi.doMock('../../db/pg-repo.js', () => ({
      query: vi.fn((sql: string) => {
        if (sql.includes('user_skill_prefs')) return Promise.resolve(prefs);
        return Promise.resolve([]);
      }),
      queryOne: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() => Promise.resolve(undefined)),
    }));
    return import('./skill-registry.ts');
  }

  const baseSkill = (name: string, visibility: string) => ({
    name,
    description: `${name} desc`,
    content: `# ${name}`,
    tags: ['core'],
    version: '1.0.0',
    skillPath: `/tmp/skills/${name}/SKILL.md`,
    tier: 'team',
    owner: 'moat',
    catalog: 'system',
    visibility,
  });

  it('injects default skills but not public/private/hidden library skills by default', async () => {
    const registry = await loadWithLibrarySkills([
      baseSkill('default-skill', 'default'),
      baseSkill('public-skill', 'public'),
      baseSkill('private-skill', 'private'),
      baseSkill('hidden-skill', 'hidden'),
    ]);

    const skills = await registry.getSkillsForSession();
    expect(skills.map((s) => s.name)).toEqual(['default-skill']);
  });

  it('injects a public skill only after explicit user enable pref', async () => {
    const registry = await loadWithLibrarySkills([
      baseSkill('default-skill', 'default'),
      baseSkill('public-skill', 'public'),
    ], [{ skill_name: 'public-skill', enabled: 1 }]);

    const skills = await registry.getSkillsForSession(1);
    expect(skills.map((s) => s.name)).toEqual(['default-skill', 'public-skill']);
  });

  it('filters list/prompt/command exposure by minimal access grants', async () => {
    const registry = await loadWithLibrarySkills([
      { ...baseSkill('everyone-skill', 'default'), access: ['everyone'] },
      { ...baseSkill('admin-skill', 'default'), access: ['user:admin'] },
      { ...baseSkill('julius-skill', 'default'), access: ['user:julius'] },
    ]);

    await expect(registry.getSkillsForSession(1, null, 'member').then((skills: any[]) => skills.map((s) => s.name)))
      .resolves.toEqual(['everyone-skill']);
    await expect(registry.getSkillsForSession(1, null, 'admin').then((skills: any[]) => skills.map((s) => s.name)))
      .resolves.toEqual(['everyone-skill', 'admin-skill']);
    await expect(registry.getCommandsForUser(1, null, 'member').then((commands: any[]) => commands.map((c) => c.name)))
      .resolves.toEqual(['/agent', '/skills', '/task list', '/compact', '/everyone-skill']);
    await expect(registry.listSkills('company', undefined, 1, 'admin').then((skills: any[]) => skills.map((s) => s.name)))
      .resolves.toEqual(['everyone-skill', 'admin-skill']);
  });

  it('treats missing access as everyone for backward compatibility', async () => {
    const registry = await loadWithLibrarySkills([
      { ...baseSkill('legacy-skill', 'default') },
    ]);

    const skills = await registry.getSkillsForSession(1, null, 'someone');
    expect(skills.map((s) => s.name)).toEqual(['legacy-skill']);
  });

  it('doctor separates registry prompt candidate from runtime capability', async () => {
    const registry = await loadWithLibrarySkills([
      {
        ...baseSkill('public-skill', 'public'),
        runtimeRequirements: { execution: 'required' },
        portability: { level: 'portable', warnings: ['Tower-specific runtime wording'] },
      },
    ]);

    const doctor = await registry.getSkillRegistryDoctor('public-skill');
    expect(doctor.registry.registered).toBe(true);
    expect(doctor.registry.visibility).toBe('public');
    expect(doctor.registry.promptCandidate).toBe(false);
    expect(doctor.runtime.requirements).toEqual({ execution: 'required' });
    expect(doctor.portability.status).toBe('WARN');
  });

  it('refuses personal snapshot copies because personal skills are deprecated', async () => {
    const registry = await loadWithLibrarySkills([]);

    await expect(registry.copySkillToPersonal('public-skill', 7))
      .rejects.toThrow('Personal skills are deprecated');
  });
});

// 2026-04-17: managed-mode detection (isManagedMode / reconcileManagedSkills)
// 는 library-as-source 재설계에서 제거됨. bootstrapLibraryProviders 가 대신
// 역할을 맡지만 DB/파일 시스템 양쪽에 의존해 단위 테스트로는 부적합하여
// 통합 테스트로 커버한다. 관련 describe 블록 삭제.
