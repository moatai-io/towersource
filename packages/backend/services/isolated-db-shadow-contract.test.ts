import path from 'path';
import { describe, expect, it } from 'vitest';
import { IsolatedDbShadowContractError, resolveIsolatedDbShadowConfig } from './isolated-db-shadow-contract.js';

const marker = 'phase5c_test_01';
const dbIdentity = `tower_shadow_${marker}`;

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TOWER_RUN_MODE: 'shadow',
    TOWER_SHADOW_PROFILE: 'isolated-db',
    TOWER_SHADOW_ROOT: '/tmp/tower-phase5c-shadow',
    TOWER_ISOLATED_DB_MARKER: marker,
    DATABASE_URL: `postgresql://${dbIdentity}:db-password@127.0.0.1:55432/${dbIdentity}?sslmode=disable`,
    TOWER_MIGRATION_DIR: '/nix/store/example/lib/tower/packages/backend/db/migrations',
    ...overrides,
  };
}

describe('isolated DB shadow contract', () => {
  it('accepts an explicit loopback database with marker-bound role and database names', () => {
    expect(resolveIsolatedDbShadowConfig(validEnv())).toMatchObject({
      runMode: 'shadow',
      profile: 'isolated-db',
      shadowRoot: '/tmp/tower-phase5c-shadow',
      databaseHost: '127.0.0.1',
      databasePort: 55432,
      databaseName: dbIdentity,
      databaseUser: dbIdentity,
      marker,
      migrationDir: '/nix/store/example/lib/tower/packages/backend/db/migrations',
    });
  });

  it.each([
    ['TOWER_RUN_MODE', 'production'],
    ['TOWER_SHADOW_PROFILE', 'artifact'],
    ['HOST', '127.0.0.1'],
    ['PORT', '32455'],
    ['PUBLIC_URL', 'https://tower.tower.example.com'],
    ['OPENAI_API_KEY', 'secret'],
    ['JWT_SECRET', 'secret'],
  ])('fails before DB import for forbidden %s', (name, value) => {
    expect(() => resolveIsolatedDbShadowConfig(validEnv({ [name]: value }))).toThrow(IsolatedDbShadowContractError);
  });

  it.each([
    'postgresql://tower_shadow_phase5c_test_01:x@20.0.0.1:5432/tower_shadow_phase5c_test_01',
    'postgresql://tower_prod:x@127.0.0.1:5432/tower_prod',
    'postgresql://tower_shadow_phase5c_test_01:x@localhost:5432/tower_shadow_phase5c_test_01',
    'mysql://tower_shadow_phase5c_test_01:x@127.0.0.1:5432/tower_shadow_phase5c_test_01',
  ])('rejects production-like or non-loopback DATABASE_URL: %s', (databaseUrl) => {
    expect(() => resolveIsolatedDbShadowConfig(validEnv({ DATABASE_URL: databaseUrl }))).toThrow(IsolatedDbShadowContractError);
  });

  it('requires role and database names to match the explicit marker', () => {
    expect(() => resolveIsolatedDbShadowConfig(validEnv({
      DATABASE_URL: `postgresql://${dbIdentity}:x@127.0.0.1:55432/other_database`,
    }))).toThrow(/database and user must both equal/);
  });

  it('uses the packaged migration directory by default without touching a DB', () => {
    const env = validEnv();
    delete env.TOWER_MIGRATION_DIR;
    const cwd = '/nix/store/example/lib/tower';
    expect(resolveIsolatedDbShadowConfig(env, cwd).migrationDir).toBe(
      path.join(cwd, 'packages/backend/db/migrations'),
    );
  });
});
