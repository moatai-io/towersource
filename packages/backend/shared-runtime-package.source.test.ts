import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sharedPackage = JSON.parse(fs.readFileSync(path.join(root, 'packages/shared/package.json'), 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sharedIndex = fs.readFileSync(path.join(root, 'packages/shared/index.ts'), 'utf8');

describe('@tower/shared production runtime package contract', () => {
  it('points production Node resolution at compiled JavaScript', () => {
    expect(sharedPackage.main).toBe('index.js');
    expect(sharedPackage.types).toBe('index.d.ts');
    expect(sharedPackage.exports['.'].default).toBe('./index.js');
    expect(sharedPackage.exports['.'].types).toBe('./index.d.ts');
  });

  it('uses explicit JavaScript extensions for runtime re-exports', () => {
    expect(sharedIndex).toContain("from './agent-career.js'");
    expect(sharedIndex).toContain("from './automation-yaml.js'");
    expect(sharedIndex).not.toContain("from './automation-yaml'");
  });

  it('copies the compiled shared package into Host production artifacts', () => {
    expect(rootPackage.scripts.build).toContain('dist/runtime-packages/@tower/shared');
    expect(rootPackage.scripts.build).toContain('dist/backend/packages/shared');
    expect(rootPackage.scripts.build).toContain('packages/shared/package.json');
  });
});
