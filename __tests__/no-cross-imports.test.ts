import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Test 3B — No cross-package imports (frontend ↔ backend).
 * Should be GREEN now and stay GREEN.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

function scanTs(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      results.push(...scanTs(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe('no cross-package imports', () => {
  it('frontend에서 backend 직접 import 없음', () => {
    // Check both old and new paths
    const frontendDirs = [
      path.join(ROOT, 'frontend', 'src'),
      path.join(ROOT, 'packages', 'frontend', 'src'),
    ];
    for (const dir of frontendDirs) {
      for (const file of scanTs(dir)) {
        const src = fs.readFileSync(file, 'utf-8');
        const rel = path.relative(ROOT, file);
        // Should not import from backend paths (but @tower/shared is OK)
        expect(src, `${rel} imports backend`).not.toMatch(
          /from\s+['"].*\/(backend|packages\/backend)\//,
        );
      }
    }
  });

  it('backend에서 frontend 직접 import 없음', () => {
    const backendDirs = [
      path.join(ROOT, 'backend'),
      path.join(ROOT, 'packages', 'backend'),
    ];
    for (const dir of backendDirs) {
      for (const file of scanTs(dir)) {
        const src = fs.readFileSync(file, 'utf-8');
        const rel = path.relative(ROOT, file);
        expect(src, `${rel} imports frontend`).not.toMatch(
          /from\s+['"].*\/(frontend|packages\/frontend)\//,
        );
      }
    }
  });
});
