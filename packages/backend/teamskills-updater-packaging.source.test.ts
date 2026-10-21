import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
describe('stable skill updater deployment packaging', () => {
  it('compiles backend scripts and copies the whole backend into both Nix artifact paths', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.backend.json'), 'utf8'));
    expect(tsconfig.include).toContain('packages/backend');
    expect(tsconfig.exclude).not.toContain('packages/backend/scripts/teamskills-stable-update.ts');
    const flake = fs.readFileSync(path.join(root, 'flake.nix'), 'utf8');
    expect(flake).toContain('cp -R ${prebuiltDist}/dist ./dist');
    expect(flake).toContain('cp -R dist/frontend dist/backend "$app/dist/"');
    expect(fs.existsSync(path.join(root, 'packages/backend/scripts/teamskills-stable-update.ts'))).toBe(true);
  });
});
