import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { frontendForEntrypoint } from '../../../../scripts/nix-app/retain-previous-frontend-assets.mjs';
describe('previous frontend deployment paths', () => {
  it('resolves app-only, immutable and host release layouts', () => {
    expect(frontendForEntrypoint('/releases/a/launch')).toBe('/releases/a/dist/frontend');
    expect(frontendForEntrypoint('/nix/store/example/bin/tower-app-start-production')).toBe('/nix/store/example/lib/tower/dist/frontend');
    expect(frontendForEntrypoint('/repo/dist/backend/packages/backend/index.js')).toBe('/repo/dist/frontend');
    expect(() => frontendForEntrypoint('/unknown')).toThrow();
  });
  it('seeds before process stop', () => {
    const script = readFileSync(new URL('../../../../scripts/nix-app/upgrade-operator-app', import.meta.url), 'utf8');
    expect(script.indexOf('node "$repo_root/scripts/nix-app/retain-previous-frontend-assets.mjs"')).toBeLessThan(script.indexOf('phase="$(date +%s%3N)"; pm2 delete'));
  });
});
