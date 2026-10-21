import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedProjectDefaultSkills } from './project-default-skills.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-default-seed-'));
  roots.push(root);
  const source = path.join(root, 'teamskills');
  const project = path.join(root, 'project');
  vi.stubEnv('TEAMSKILLS_PROJECT_ROOT', source);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const add = (name: string) => {
    const dir = path.join(source, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test\n---\nTest`);
    return dir;
  };
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(project, '.tower', 'skills', name), 'utf8'));
  return { root, project, warn, add, read };
}
describe('new Project optional default skill materialization', () => {
  it('connects the scaffold to optional default seeding', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, 'project-manager.ts'), 'utf8');
    const seed = source.slice(source.indexOf('function seedProjectFolder('), source.indexOf('export async function createProject('));
    expect(seed).toContain('seedProjectDefaultSkills(finalDir, readTeamskillsSkillset(');
    expect(seed).not.toContain('SKILL_SOURCE_INCOMPLETE');
  });
  it('keeps available defaults and records missing defaults without blocking creation', () => {
    const f = fixture(); f.add('available');
    expect(() => seedProjectDefaultSkills(f.project, ['available', 'missing'])).not.toThrow();
    expect(f.read('manifest.json').skills.map((s: { name: string }) => s.name)).toEqual(['available']);
    expect(f.read('seed-status.json')).toMatchObject({ status: 'degraded', skipped: [{ name: 'missing', reason: 'not_found_or_disallowed' }] });
    expect(f.warn).toHaveBeenCalledOnce();
  });
  it('writes an explicit empty allowlist when every default is unavailable', () => {
    const f = fixture();
    seedProjectDefaultSkills(f.project, ['missing']);
    expect(f.read('manifest.json')).toMatchObject({ schemaVersion: 3, managedBy: 'tower-project-skill-runtime-layer', skills: [] });
  });
  it('excludes unsafe bundles rather than weakening source validation', () => {
    const f = fixture(); const dir = f.add('unsafe');
    fs.writeFileSync(path.join(f.root, 'outside.txt'), 'outside');
    fs.symlinkSync(path.join(f.root, 'outside.txt'), path.join(dir, 'escape.txt'));
    seedProjectDefaultSkills(f.project, ['unsafe']);
    expect(f.read('manifest.json').skills).toEqual([]);
    expect(f.read('seed-status.json').skipped).toEqual([{ name: 'unsafe', reason: 'scan_failed' }]);
  });
  it('records ready status for complete defaults without warning', () => {
    const f = fixture(); f.add('available');
    seedProjectDefaultSkills(f.project, ['available']);
    expect(f.read('seed-status.json')).toMatchObject({ status: 'ready', skipped: [] });
    expect(f.warn).not.toHaveBeenCalled();
  });
  it('automatically seeds Gateway declarations for new Agent image skills without storing keys', () => {
    const f = fixture();
    for (const name of ['image-gen', 'image-slide-gen']) {
      const dir = f.add(name);
      fs.writeFileSync(path.join(dir, 'skill.yaml'), `name: ${name}\nversion: 1.0.0\nrequiredSecrets: []\ngatewayApis: '[{"apiId":"openai-image","apiKeyEnv":"OPENAI_IMAGE_API_KEY","baseUrlEnv":"OPENAI_IMAGE_BASE_URL"}]'\n`);
    }
    seedProjectDefaultSkills(f.project, ['image-gen', 'image-slide-gen']);
    const manifest = f.read('manifest.json');
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.skills).toHaveLength(2);
    for (const skill of manifest.skills) {
      expect(skill.gatewayApis).toEqual([{ apiId: 'openai-image', apiKeyEnv: 'OPENAI_IMAGE_API_KEY', baseUrlEnv: 'OPENAI_IMAGE_BASE_URL' }]);
      expect(skill.requiredSecrets).toEqual([]);
      expect(skill).not.toHaveProperty('apiKey');
    }
    expect(f.read('seed-status.json')).toMatchObject({ status: 'ready', skipped: [] });
  });
  it('still propagates storage errors for scaffold rollback', () => {
    const f = fixture();
    fs.writeFileSync(f.project, 'not a directory');
    expect(() => seedProjectDefaultSkills(f.project, ['missing'])).toThrow();
  });
});
