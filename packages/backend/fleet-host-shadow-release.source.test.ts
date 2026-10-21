import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const release = fs.readFileSync(path.join(root, 'scripts/fleet/fleet-release.sh'), 'utf8');
const builder = fs.readFileSync(path.join(root, 'scripts/fleet/build-host-shadow-release'), 'utf8');
const skill = fs.readFileSync(path.join(root, 'skills/fleet/SKILL.md'), 'utf8');

describe('Fleet Host Shadow release option', () => {
  it('routes the explicit option to a non-deploy artifact builder', () => {
    expect(release).toContain('--host-shadow');
    expect(release).toContain('build-host-shadow-release');
    expect(release.indexOf('if [[ "$HOST_SHADOW" -eq 1 ]]')).toBeLessThan(release.indexOf('git tag -a'));
  });

  it('builds from one exact origin/main commit without mutable or secret paths', () => {
    expect(builder).toContain('git -C "$repo_root" archive --format=tar "$source_rev"');
    expect(builder).toContain('merge-base --is-ancestor "$source_rev" origin/main');
    expect(builder).toContain('npm ci --no-audit --no-fund');
    expect(builder).toContain('npm prune --omit=dev');
    expect(builder).toContain('for forbidden in .env data workspace uploads published logs .git');
    expect(builder).not.toContain('git push');
    expect(builder).not.toContain('pm2 start');
    expect(builder).not.toContain('ssh ');
  });

  it('writes exact identity and verifies extracted runtime contents', () => {
    expect(builder).toContain('SOURCE_REV=$source_rev');
    expect(builder).toContain('TOWER_RELEASE_METADATA_REQUIRED=1');
    expect(builder).toContain('tower-host-shadow-$source_rev.tar.zst');
    expect(builder).toContain('productionDependencies');
    expect(builder).toContain('releaseIdentity');
  });

  it('documents that Host Shadow is separate from tag release and customer Nix rollout', () => {
    expect(skill).toContain('/fleet release [patch|minor|major|--host-shadow]');
    expect(skill).toContain('tag/push');
    expect(skill).toContain('Customer/Fleet는 시험 기간에도 기존 signed Nix closure 경로를 유지한다.');
    expect(skill).toContain('2026-08-30-fleet-host-shadow-release-option.md');
    expect(skill).toContain('/checkpoint');
  });
});
