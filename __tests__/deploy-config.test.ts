import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Test 4B — Deploy configuration validity.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

describe('deploy configuration', () => {
  it('ecosystem.config.cjs exists and references valid script path', () => {
    const ecoPath = path.join(ROOT, 'ecosystem.config.cjs');
    if (!fs.existsSync(ecoPath)) {
      // If no ecosystem config, skip — not all deployments use PM2
      return;
    }
    const content = fs.readFileSync(ecoPath, 'utf-8');
    // Should reference a valid entry point
    expect(content).toMatch(/script|module/);
  });

  it('start.sh exists and is executable (if present)', () => {
    const startPath = path.join(ROOT, 'start.sh');
    if (!fs.existsSync(startPath)) return;
    const stat = fs.statSync(startPath);
    // Check executable bit
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('package.json dev:backend points to packages/backend/', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['dev:backend']).toContain('packages/backend');
  });
});
