import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Test 3A — Workspace structure verification.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

function readPkg(rel: string) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel, 'package.json'), 'utf-8'));
}

describe('workspace structure', () => {
  it('root package.json에 workspaces: ["packages/*"]', () => {
    const pkg = readPkg('.');
    expect(pkg.workspaces).toContain('packages/*');
  });

  it('@tower/frontend package.json 존재', () => {
    const pkg = readPkg('packages/frontend');
    expect(pkg.name).toBe('@tower/frontend');
  });

  it('@tower/backend package.json 존재', () => {
    const pkg = readPkg('packages/backend');
    expect(pkg.name).toBe('@tower/backend');
  });

  it('@tower/frontend에 react, recharts, katex 있음', () => {
    const pkg = readPkg('packages/frontend');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps).toHaveProperty('react');
    expect(deps).toHaveProperty('recharts');
    expect(deps).toHaveProperty('katex');
  });

  it('@tower/backend에 pg 있음', () => {
    const pkg = readPkg('packages/backend');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps).toHaveProperty('pg');
  });

  it('root에 frontend-only/heavy native deps 없음; backend runtime deps는 허용', () => {
    const pkg = readPkg('.');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps).not.toHaveProperty('react');
    expect(deps).not.toHaveProperty('better-sqlite3');
    // Built backend runs from dist/backend and resolves external packages from the
    // repo root node_modules on self-hosted servers, so pg and other backend runtime deps
    // may be duplicated at the root intentionally.
    expect(deps).toHaveProperty('pg');
  });

  it('@tower/shared는 * 버전 참조', () => {
    const fe = readPkg('packages/frontend');
    const be = readPkg('packages/backend');
    const feDeps = { ...fe.dependencies, ...fe.devDependencies };
    const beDeps = { ...be.dependencies, ...be.devDependencies };
    // At least one should reference @tower/shared
    const refs = [feDeps['@tower/shared'], beDeps['@tower/shared']].filter(Boolean);
    expect(refs.length).toBeGreaterThan(0);
    for (const v of refs) {
      expect(v).toBe('*');
    }
  });
});
