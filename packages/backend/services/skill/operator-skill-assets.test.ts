import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOperatorSkillAssets } from './operator-skill-assets.js';
import { resolveRegistrySkillBundle } from './skill-bundle-resolver.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-assets-')); roots.push(root);
  const org = path.join(root, 'org'); const project = path.join(root, 'project');
  vi.stubEnv('TEAMSKILLS_PROJECT_ROOT', org);
  const source = path.join(org, 'skills/issue'); fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# issue');
  fs.writeFileSync(path.join(source, 'resolution.md'), 'Original reference');
  const bundle = resolveRegistrySkillBundle('issue')!;
  const manifest = path.join(project, '.tower/skills/manifest.json'); fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 3, skills: [{ name: 'issue', sourceKind: 'teamskills', canonicalId: bundle.canonicalId, bundleDigest: bundle.bundleDigest }] }));
  return { source, project, manifest };
}
describe('Operator skill asset source resolution', () => {
  it('resolves the complete source even when the project contains only control files', () => {
    const f = fixture();
    expect(resolveOperatorSkillAssets(f.project, 'issue', '# issue')).toMatchObject({ status: 'source-verified', sourceDirectory: f.source, files: ['SKILL.md', 'resolution.md'] });
  });
  it('provides and executes a complete project-local snapshot without changing the control manifest', () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.source, 'scripts'));
    fs.writeFileSync(path.join(f.source, 'scripts/probe.js'), "console.log(require('fs').readFileSync(require('path').join(__dirname, '../resolution.md'), 'utf8'))");
    const bundle = resolveRegistrySkillBundle('issue')!;
    const data = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
    data.skills[0].bundleDigest = bundle.bundleDigest;
    fs.writeFileSync(f.manifest, JSON.stringify(data));
    const before = fs.readFileSync(f.manifest, 'utf8');
    const result = resolveOperatorSkillAssets(f.project, 'issue', '# issue');
    expect(result.status).toBe('source-verified');
    if (result.status !== 'source-verified') throw new Error('snapshot blocked');
    expect(result.executionDirectory.startsWith(f.project + path.sep)).toBe(true);
    expect(result.bodyOnly).toBe(false);
    expect(execFileSync(process.execPath, [path.join(result.executionDirectory, 'scripts/probe.js')], { encoding: 'utf8' }).trim()).toBe('Original reference');
    expect(fs.readFileSync(f.manifest, 'utf8')).toBe(before);
    const reused = resolveOperatorSkillAssets(f.project, 'issue', '# issue');
    expect(reused).toMatchObject({ executionDirectory: result.executionDirectory, bodyOnly: false });
    fs.writeFileSync(path.join(result.executionDirectory, 'resolution.md'), 'tampered');
    expect(resolveOperatorSkillAssets(f.project, 'issue', '# issue').status).toBe('blocked');
  });
  it('refuses a symlinked snapshot parent without writing outside the project', () => {
    const f = fixture();
    const outside = path.join(f.source, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.project, '.tower/skill-assets'));
    expect(resolveOperatorSkillAssets(f.project, 'issue', '# issue').status).toBe('blocked');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it('rejects a dangling snapshot-parent symlink', () => {
    const f = fixture();
    fs.symlinkSync(path.join(f.project, 'absent'), path.join(f.project, '.tower/skill-assets'));
    expect(resolveOperatorSkillAssets(f.project, 'issue', '# issue').status).toBe('blocked');
    expect(fs.existsSync(path.join(f.project, 'absent'))).toBe(false);
  });
  it('blocks changed reference bytes without exposing the source path', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.source, 'resolution.md'), 'Changed');
    expect(resolveOperatorSkillAssets(f.project, 'issue', '# issue')).toEqual({ status: 'blocked', reason: 'bundle_digest_mismatch' });
  });
  it('blocks a project override with different body bytes', () => {
    const f = fixture(); expect(resolveOperatorSkillAssets(f.project, 'issue', '# local override')).toEqual({ status: 'blocked', reason: 'body_source_mismatch' });
  });
  it('blocks symlinked bundle references', () => {
    const f = fixture(); fs.symlinkSync(path.join(f.source, 'resolution.md'), path.join(f.source, 'alias.md'));
    expect(resolveOperatorSkillAssets(f.project, 'issue', '# issue').status).toBe('blocked');
  });
  it('requires manifest membership and safe names', () => {
    const f = fixture();
    expect(resolveOperatorSkillAssets(f.project, 'other', '# issue')).toEqual({ status: 'blocked', reason: 'not_manifest_listed' });
    expect(resolveOperatorSkillAssets(f.project, '../issue', '# issue')).toEqual({ status: 'blocked', reason: 'invalid_context' });
  });
});
