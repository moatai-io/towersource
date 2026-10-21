import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFrontendSourceRev } from '../../scripts/frontend-source-rev.mjs';
import { verifyFrontendRelease } from '../../scripts/verify-frontend-release.mjs';

const target = 'a'.repeat(40);
const staleRuntime = 'b'.repeat(40);
const noGit = () => { throw new Error('No Git in source archive'); };

describe('frontend build source identity', () => {
  it('prefers the attested archive SHA over an inherited runtime SOURCE_REV', () => {
    expect(resolveFrontendSourceRev({ env: { TOWER_SOURCE_SHA: target, SOURCE_REV: staleRuntime }, readGit: noGit })).toBe(target);
  });

  it('prefers the live checkout SHA over an inherited runtime SOURCE_REV', () => {
    expect(resolveFrontendSourceRev({ env: { SOURCE_REV: staleRuntime }, readGit: () => target })).toBe(target);
  });

  it('uses explicit SOURCE_REV in no-Git packaged source', () => {
    expect(resolveFrontendSourceRev({ env: { SOURCE_REV: target }, readGit: noGit })).toBe(target);
  });

  it('does not embed malformed source identities', () => {
    expect(resolveFrontendSourceRev({ env: { TOWER_SOURCE_SHA: 'invalid', SOURCE_REV: 'invalid' }, readGit: noGit })).toBe('');
  });

  it('does not configure a precached navigation fallback when HTML is excluded from the precache', () => {
    const vite = readFileSync('vite.config.ts', 'utf8');
    expect(vite).toContain("globPatterns: ['**/*.{css,ico,png,svg,woff2}']");
    expect(vite).toContain('navigateFallback: null');
    expect(vite).not.toMatch(/navigateFallback: ['"]\/index\.html['"]/);
  });

  it('wires the resolver into Vite and supplies the Nix build revision', () => {
    const vite = readFileSync('vite.config.ts', 'utf8');
    const flake = readFileSync('flake.nix', 'utf8');
    expect(vite).toContain('const frontendSourceRev = resolveFrontendSourceRev();');
    expect(vite).toContain('__TOWER_FRONTEND_SOURCE_REV__: JSON.stringify(frontendSourceRev)');
    expect(vite).toContain("fileName: 'frontend-release.json'");
    expect(vite).toContain('JSON.stringify({ sourceRev: frontendSourceRev })');
    expect(flake).toContain('SOURCE_REV = sourceRev;');
    expect(readFileSync('scripts/git/pre-push-verified-state', 'utf8')).toContain('TOWER_SOURCE_SHA="$local_sha"');
  });

  it('rejects missing or mismatched frontend identities before release promotion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tower-frontend-release-'));
    try {
      expect(() => verifyFrontendRelease(dir, target)).toThrow();
      writeFileSync(join(dir, 'frontend-release.json'), JSON.stringify({ sourceRev: staleRuntime }));
      expect(() => verifyFrontendRelease(dir, target)).toThrow('source revision mismatch');
      writeFileSync(join(dir, 'frontend-release.json'), JSON.stringify({ sourceRev: target }));
      expect(verifyFrontendRelease(dir, target)).toEqual({ sourceRev: target });
      expect(() => verifyFrontendRelease(dir, 'invalid')).toThrow('full SHA');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
