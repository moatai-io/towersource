import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  APP_PACKAGE_FORBIDDEN_INPUTS,
  APP_RUNTIME_PATH_CONTRACT,
  PACKAGED_RELEASE_REQUIRED_ENV,
} from './app-runtime-contract.js';

const root = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

describe('Phase 5 app runtime contract', () => {
  it('keeps immutable package paths unique and under lib/tower', () => {
    const immutable = APP_RUNTIME_PATH_CONTRACT.filter((entry) => entry.classification === 'immutable');
    const packagedPaths = immutable.map((entry) => entry.packagedPath);

    expect(immutable.every((entry) => entry.required)).toBe(true);
    expect(packagedPaths.every((entry) => entry?.startsWith('lib/tower/'))).toBe(true);
    expect(new Set(packagedPaths).size).toBe(packagedPaths.length);
  });

  it('requires explicit external roots for writable runtime state', () => {
    const writable = APP_RUNTIME_PATH_CONTRACT.filter((entry) => entry.classification === 'external-writable');
    expect(writable.map((entry) => entry.runtimeEnv).sort()).toEqual(['TOWER_DATA_DIR', 'WORKSPACE_ROOT']);
    expect(writable.every((entry) => entry.packagedPath === undefined)).toBe(true);
  });

  it('excludes secrets, mutable state and local build products from package inputs', () => {
    expect(APP_PACKAGE_FORBIDDEN_INPUTS).toEqual(expect.arrayContaining([
      '.env', '.git', 'data', 'dist', 'node_modules', 'workspace', 'uploads', 'published',
    ]));
  });

  it('matches the no-Git release identity required by pkg-info', () => {
    expect(PACKAGED_RELEASE_REQUIRED_ENV).toEqual([
      'TOWER_VERSION', 'TOWER_BASE_VERSION', 'GIT_SHA', 'SOURCE_REV',
    ]);
    const pkgInfo = read('packages/backend/utils/pkg-info.ts');
    for (const envName of PACKAGED_RELEASE_REQUIRED_ENV) expect(pkgInfo).toContain(envName);
  });

  it('records current cwd-based writable state as migration debt instead of packaging it', () => {
    const evidence = [
      read('packages/backend/services/message-store.ts'),
      read('packages/backend/services/ai/claude-sdk.ts'),
      read('packages/backend/services/ai/pi-session-runtime.ts'),
    ].join('\n');
    expect(evidence).toContain("path.join(process.cwd(), 'data'");

    const runtimeState = APP_RUNTIME_PATH_CONTRACT.find((entry) => entry.id === 'runtime-state');
    expect(runtimeState).toMatchObject({
      classification: 'external-writable',
      runtimeEnv: 'TOWER_DATA_DIR',
    });
    expect(runtimeState).not.toHaveProperty('packagedPath');
  });

  it('links the contract to the accepted Phase 5 and Phase 6 decisions', () => {
    const contract = read('packages/backend/services/app-runtime-contract.ts');
    expect(contract).toContain('2026-07-16-nix-renderer-authority-and-tower-app-shadow-phase5.md');
    expect(contract).toContain('2026-07-17-nix-tower-app-production-phase6.md');
  });
});
