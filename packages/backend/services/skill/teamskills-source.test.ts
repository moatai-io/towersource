import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-teamskills-source-'));
  tempDirs.push(dir);
  return dir;
}

async function loadWithHome(home: string) {
  vi.resetModules();
  process.env.TEAMSKILLS_PROJECT_ROOT = path.join(home, 'workspace', 'projects', 'teamskills');
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return { ...actual, default: { ...actual.default, homedir: () => home }, homedir: () => home };
  });
  return import('./teamskills-source.ts');
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('os');
  delete process.env.WORKSPACE_ROOT;
  delete process.env.TEAMSKILLS_PROJECT_ROOT;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('teamskills-source', () => {
  it('reads defaultSkills from teamskills/skillset.json with validation and dedupe', async () => {
    const home = makeTempHome();
    const root = path.join(home, 'workspace', 'projects', 'teamskills');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'skillset.json'), JSON.stringify({
      version: 1,
      defaultSkills: ['share-skill', 'bad/name', 'share-skill', '', { name: 'web-capture' }],
    }));

    const { readTeamskillsSkillset, validateTeamskillsSkillset } = await loadWithHome(home);
    expect(readTeamskillsSkillset(['fallback'])).toEqual(['share-skill', 'web-capture']);
    const result = validateTeamskillsSkillset(['fallback']);
    expect(result.source).toBe('teamskills');
    expect(result.skills).toEqual(['share-skill', 'web-capture']);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'defaultSkills[1] has invalid skill name: bad/name',
      'duplicate skill ignored: share-skill',
      'defaultSkills[3] must be a skill name string or { name } object',
    ]));
  });

  it('falls back when skillset is missing or invalid', async () => {
    const home = makeTempHome();
    const { readTeamskillsSkillset, validateTeamskillsSkillset } = await loadWithHome(home);
    expect(readTeamskillsSkillset(['agents-md'])).toEqual(['agents-md']);
    const result = validateTeamskillsSkillset(['agents-md']);
    expect(result.source).toBe('missing');
    expect(result.warnings[0]).toContain('teamskills skillset unavailable');
  });
});
