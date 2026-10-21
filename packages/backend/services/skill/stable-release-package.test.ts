import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packageStableSkillSource, signStableSkillRelease } from './stable-release-package.js';
import { updateStableSkills } from './stable-release-updater.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-package-')); roots.push(root);
  const source = path.join(root, 'source');
  const skill = path.join(source, 'skills', 'alpha');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'skillset.json'), JSON.stringify({ defaultSkills: ['alpha'] }));
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Alpha');
  fs.writeFileSync(path.join(skill, 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  return { root, source, skill };
}
describe('stable release offline packaging', () => {
  it('produces deterministic strict ustar and exact Ed25519 signed descriptor readable by updater check', () => {
    const f = fixture();
    const first = packageStableSkillSource(f.source);
    fs.utimesSync(path.join(f.skill, 'SKILL.md'), new Date(0), new Date());
    expect(packageStableSkillSource(f.source)).toEqual(first);
    expect(gunzipSync(first).length).toBeGreaterThan(first.length);
    const keys = crypto.generateKeyPairSync('ed25519');
    const input = signStableSkillRelease(f.source, 'v1.0.0', 'a'.repeat(40), keys.privateKey);
    expect(crypto.verify(null, input.descriptor, keys.publicKey, input.signature)).toBe(true);
    const sourceRoot = path.join(f.root, 'teamskills');
    const releasesRoot = path.join(f.root, 'releases');
    const project = path.join(f.root, 'project');
    fs.mkdirSync(path.join(sourceRoot, '.tower'), { recursive: true });
    fs.mkdirSync(path.join(project, '.tower/skills'), { recursive: true });
    fs.mkdirSync(releasesRoot);
    fs.writeFileSync(path.join(project, '.tower/skills/manifest.json'), JSON.stringify({ schemaVersion: 3, managedBy: 'tower-project-skill-runtime-layer', skills: [] }));
    fs.writeFileSync(path.join(sourceRoot, '.tower/stable-skills-policy.json'), JSON.stringify({ schemaVersion: 1, enrollments: [{ name: 'alpha', localDigest: null }] }));
    vi.stubEnv('TEAMSKILLS_PROJECT_ROOT', sourceRoot); vi.stubEnv('TEAMSKILLS_STABLE_RELEASES_ROOT', releasesRoot);
    expect(updateStableSkills({ sourceRoot, releasesRoot, projectRoots: [project], mode: 'check', input: { ...input, publicKey: keys.publicKey } }).status).toBe('eligible');
    expect(fs.readdirSync(releasesRoot)).toEqual([]);
  });
  it('rejects source symlinks and unsafe filenames before creating an archive', () => {
    const f = fixture();
    fs.symlinkSync(path.join(f.skill, 'SKILL.md'), path.join(f.skill, 'alias.md'));
    expect(() => packageStableSkillSource(f.source)).toThrow('unsafe skill bundle');
    fs.unlinkSync(path.join(f.skill, 'alias.md'));
    fs.writeFileSync(path.join(f.skill, '.env'), 'fixture-only');
    expect(() => packageStableSkillSource(f.source)).toThrow('unsafe skill bundle');
  });
});
