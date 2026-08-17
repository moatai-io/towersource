import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Test 4A — Build output smoke test.
 * Verifies that `npm run build` produces expected artifacts.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

describe('build smoke test', () => {
  it('vite build produces dist/frontend/index.html', () => {
    // Run the build
    execSync('npm run build', { cwd: ROOT, timeout: 60_000, stdio: 'pipe' });
    expect(fs.existsSync(path.join(ROOT, 'dist', 'frontend', 'index.html'))).toBe(true);
  }, 90_000);

  it('tsc produces dist/backend/packages/backend/index.js', () => {
    // Build already ran in previous test; just check output
    const entryPoint = path.join(ROOT, 'dist', 'backend', 'packages', 'backend', 'index.js');
    expect(fs.existsSync(entryPoint)).toBe(true);
  });
});
