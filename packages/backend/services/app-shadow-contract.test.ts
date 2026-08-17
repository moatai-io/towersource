import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveArtifactShadowConfig, ShadowContractError } from './app-shadow-contract.js';

const root = path.resolve('/tmp/tower-shadow-test');

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TOWER_RUN_MODE: 'shadow',
    TOWER_SHADOW_PROFILE: 'artifact',
    HOST: '127.0.0.1',
    PORT: '32454',
    TOWER_SHADOW_ROOT: root,
    TOWER_DATA_DIR: path.join(root, 'data'),
    WORKSPACE_ROOT: path.join(root, 'workspace'),
    DEFAULT_CWD: path.join(root, 'workspace', 'fixture'),
    TOWER_VERSION: '1.70.42+15',
    TOWER_BASE_VERSION: '1.70.42',
    GIT_SHA: '8beaac3287bb',
    SOURCE_REV: '8beaac3287bb65e2d3fa00e60510843578fccfec',
    ...overrides,
  };
}

describe('artifact shadow startup contract', () => {
  it('accepts an explicit loopback-only synthetic state profile', () => {
    expect(resolveArtifactShadowConfig(validEnv())).toEqual({
      runMode: 'shadow',
      profile: 'artifact',
      host: '127.0.0.1',
      port: 32454,
      shadowRoot: root,
      dataDir: path.join(root, 'data'),
      workspaceRoot: path.join(root, 'workspace'),
      defaultCwd: path.join(root, 'workspace', 'fixture'),
    });
  });

  it.each([
    ['TOWER_RUN_MODE', undefined],
    ['TOWER_RUN_MODE', 'production'],
    ['TOWER_SHADOW_PROFILE', 'isolated-db'],
    ['HOST', '0.0.0.0'],
    ['HOST', 'localhost'],
    ['PORT', '32354'],
    ['PORT', '32364'],
    ['PORT', '80'],
    ['PUBLIC_URL', 'https://tower.tower.example.com'],
    ['SHARE_PUBLIC_URL', 'https://tower.tower.example.com'],
    ['DATABASE_URL', 'postgres://production'],
    ['JWT_SECRET', 'production-secret'],
    ['OPENAI_API_KEY', 'secret'],
  ])('fails closed for %s=%s', (name, value) => {
    const env = validEnv();
    if (value === undefined) delete env[name];
    else env[name] = value;
    expect(() => resolveArtifactShadowConfig(env)).toThrow(ShadowContractError);
  });

  it.each([
    ['TOWER_DATA_DIR', '/tmp/outside/data'],
    ['WORKSPACE_ROOT', '/tmp/outside/workspace'],
    ['DEFAULT_CWD', '/tmp/outside/cwd'],
    ['TOWER_SHADOW_ROOT', 'relative/shadow'],
  ])('rejects state outside the dedicated shadow root: %s', (name, value) => {
    expect(() => resolveArtifactShadowConfig(validEnv({ [name]: value }))).toThrow(ShadowContractError);
  });

  it('permits only release provenance variables that happen to end in hash-like names', () => {
    expect(() => resolveArtifactShadowConfig(validEnv({
      FLAKE_LOCK_NAR_HASH: 'sha256-example',
      TOWER_COMMITS_SINCE_TAG: '15',
    }))).not.toThrow();
  });
});
