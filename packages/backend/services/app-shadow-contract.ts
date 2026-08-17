import path from 'path';

export type TowerRunMode = 'shadow';
export type TowerShadowProfile = 'artifact';

export interface ArtifactShadowConfig {
  runMode: TowerRunMode;
  profile: TowerShadowProfile;
  host: '127.0.0.1' | '::1';
  port: number;
  shadowRoot: string;
  dataDir: string;
  workspaceRoot: string;
  defaultCwd: string;
}

export class ShadowContractError extends Error {
  constructor(message: string) {
    super(`Artifact shadow contract violation: ${message}`);
    this.name = 'ShadowContractError';
  }
}

const PRODUCTION_PORTS = new Set([32354, 32364]);
const RELEASE_METADATA_ENV = new Set([
  'TOWER_VERSION',
  'TOWER_BASE_VERSION',
  'TOWER_COMMITS_SINCE_TAG',
  'GIT_SHA',
  'SOURCE_REV',
  'BUILD_TIME',
  'FLAKE_LOCK_NAR_HASH',
]);
const EXPLICIT_SECRET_ENV = new Set([
  'DATABASE_URL',
  'JWT_SECRET',
  'SECRET_STORE_MASTER_KEY',
  'PUBLISH_API_KEY',
  'WEB_PUSH_PRIVATE_KEY',
  'GOOGLE_CLIENT_SECRET',
]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ShadowContractError(`${name} must be set explicitly`);
  return value;
}

function absolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) throw new ShadowContractError(`${name} must be an absolute path`);
  return path.resolve(value);
}

function requireDescendant(name: string, candidate: string, root: string): void {
  if (candidate === root || !candidate.startsWith(root + path.sep)) {
    throw new ShadowContractError(`${name} must be a descendant of TOWER_SHADOW_ROOT`);
  }
}

function credentialLike(name: string): boolean {
  if (RELEASE_METADATA_ENV.has(name)) return false;
  return EXPLICIT_SECRET_ENV.has(name)
    || /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY)$/.test(name);
}

/**
 * Fail-closed contract for Phase 5B's artifact-only shadow server.
 *
 * The artifact profile never imports the production API, database, scheduler,
 * recovery, WebSocket, workspace-git, publishing, sandbox or Runtime Box paths.
 * This validator additionally refuses production-like network/data/secrets so a
 * future operator cannot accidentally turn the artifact server into a second
 * Tower authority by copying the production environment.
 */
export function resolveArtifactShadowConfig(env: NodeJS.ProcessEnv = process.env): ArtifactShadowConfig {
  if (required(env, 'TOWER_RUN_MODE') !== 'shadow') {
    throw new ShadowContractError('TOWER_RUN_MODE must equal shadow');
  }
  if (required(env, 'TOWER_SHADOW_PROFILE') !== 'artifact') {
    throw new ShadowContractError('TOWER_SHADOW_PROFILE must equal artifact');
  }

  const host = required(env, 'HOST');
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new ShadowContractError('HOST must be an explicit loopback address');
  }

  const rawPort = required(env, 'PORT');
  if (!/^\d+$/.test(rawPort)) throw new ShadowContractError('PORT must be an integer');
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new ShadowContractError('PORT must be between 1024 and 65535');
  }
  if (PRODUCTION_PORTS.has(port)) {
    throw new ShadowContractError(`PORT ${port} is reserved for Tower production/dev authority`);
  }

  if (env.PUBLIC_URL?.trim() || env.SHARE_PUBLIC_URL?.trim()) {
    throw new ShadowContractError('PUBLIC_URL and SHARE_PUBLIC_URL must be unset');
  }

  const leakedCredentials = Object.entries(env)
    .filter(([name, value]) => Boolean(value?.trim()) && credentialLike(name))
    .map(([name]) => name)
    .sort();
  if (leakedCredentials.length > 0) {
    throw new ShadowContractError(`credential-like environment must be absent: ${leakedCredentials.join(', ')}`);
  }

  const shadowRoot = absolute('TOWER_SHADOW_ROOT', required(env, 'TOWER_SHADOW_ROOT'));
  const dataDir = absolute('TOWER_DATA_DIR', required(env, 'TOWER_DATA_DIR'));
  const workspaceRoot = absolute('WORKSPACE_ROOT', required(env, 'WORKSPACE_ROOT'));
  const defaultCwd = absolute('DEFAULT_CWD', required(env, 'DEFAULT_CWD'));
  requireDescendant('TOWER_DATA_DIR', dataDir, shadowRoot);
  requireDescendant('WORKSPACE_ROOT', workspaceRoot, shadowRoot);
  requireDescendant('DEFAULT_CWD', defaultCwd, workspaceRoot);

  return {
    runMode: 'shadow',
    profile: 'artifact',
    host,
    port,
    shadowRoot,
    dataDir,
    workspaceRoot,
    defaultCwd,
  };
}
