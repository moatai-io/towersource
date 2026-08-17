import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Test 1A — Shared package structure verification.
 * Starts RED → GREEN after packages/shared/ is created with all types.
 */

const SHARED_ROOT = path.resolve(import.meta.dirname, '..');

describe('@tower/shared — package structure', () => {
  it('package.json 존재, name = @tower/shared', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(SHARED_ROOT, 'package.json'), 'utf-8'),
    );
    expect(pkg.name).toBe('@tower/shared');
  });

  it('dependencies 비어있음', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(SHARED_ROOT, 'package.json'), 'utf-8'),
    );
    const deps = pkg.dependencies || {};
    expect(Object.keys(deps)).toHaveLength(0);
  });

  const requiredExports = [
    'SessionMeta',
    'TaskMeta',
    'Project',
    'Pin',
    'FileEntry',
    'GitCommitInfo',
    'WorkflowMode',
    'PromptItem',
  ] as const;

  for (const name of requiredExports) {
    it(`index.ts가 ${name} export`, async () => {
      const indexPath = path.join(SHARED_ROOT, 'index.ts');
      const source = fs.readFileSync(indexPath, 'utf-8');
      // Check that the type name appears in an export statement
      expect(source).toMatch(new RegExp(`\\b${name}\\b`));
    });
  }
});
