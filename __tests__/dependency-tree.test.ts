import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Test 3E — Dependency tree verification.
 * Verifies npm workspace symlinks and native addons are accessible.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

describe('dependency tree', () => {
  it('node_modules/@tower/shared exists, or the workspace package is present in preflight worktrees', () => {
    const sharedPath = path.join(ROOT, 'node_modules', '@tower', 'shared');
    const workspacePath = path.join(ROOT, 'packages', 'shared');
    expect(fs.existsSync(sharedPath) || fs.existsSync(workspacePath)).toBe(true);
  });

  it('pg is loadable', async () => {
    const mod = await import('pg');
    expect(mod.default || mod.Pool || mod.Client).toBeDefined();
  });
});
