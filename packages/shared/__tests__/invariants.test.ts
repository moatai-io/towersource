import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Test 1C — Runtime dependency zero invariant.
 * @tower/shared must have NO runtime dependencies.
 */

const SHARED_ROOT = path.resolve(import.meta.dirname, '..');

describe('@tower/shared — zero dependencies invariant', () => {
  it('package.json dependencies 비어있음', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(SHARED_ROOT, 'package.json'), 'utf-8'),
    );
    const deps = pkg.dependencies || {};
    expect(Object.keys(deps)).toHaveLength(0);
  });

  it('node: built-in import 없음', () => {
    const src = fs.readFileSync(path.join(SHARED_ROOT, 'index.ts'), 'utf-8');
    // No node: protocol imports (fs, path, etc.)
    expect(src).not.toMatch(/from\s+['"]node:/);
    expect(src).not.toMatch(/import\s+.*['"]fs['"]/);
    expect(src).not.toMatch(/import\s+.*['"]path['"]/);
  });

  it('react/express/pg import 없음', () => {
    const src = fs.readFileSync(path.join(SHARED_ROOT, 'index.ts'), 'utf-8');
    expect(src).not.toMatch(/from\s+['"]react['"]/);
    expect(src).not.toMatch(/from\s+['"]express['"]/);
    expect(src).not.toMatch(/from\s+['"]pg['"]/);
  });
});
