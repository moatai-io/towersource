import path from 'path';

export interface IsolatedDbShadowConfig {
  runMode: 'shadow';
  profile: 'isolated-db';
  shadowRoot: string;
  databaseUrl: string;
  databaseHost: '127.0.0.1' | '::1';
  databasePort: number;
  databaseName: string;
  databaseUser: string;
  marker: string;
  migrationDir: string;
}

export class IsolatedDbShadowContractError extends Error {
  constructor(message: string) {
    super(`Isolated DB shadow contract violation: ${message}`);
    this.name = 'IsolatedDbShadowContractError';
  }
}

const CREDENTIAL_ENV = /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$/;
const EXPLICIT_CREDENTIAL_ENV = new Set(['JWT_SECRET', 'SECRET_STORE_MASTER_KEY', 'PUBLISH_API_KEY', 'WEB_PUSH_PRIVATE_KEY']);
const ALLOWED_CREDENTIAL_ENV = new Set(['DATABASE_URL']);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new IsolatedDbShadowContractError(`${name} must be set explicitly`);
  return value;
}

function parseLoopbackDatabaseUrl(raw: string): {
  normalized: string;
  host: '127.0.0.1' | '::1';
  port: number;
  database: string;
  user: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IsolatedDbShadowContractError('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new IsolatedDbShadowContractError('DATABASE_URL must use postgres:// or postgresql://');
  }
  const host = url.hostname;
  if (host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
    throw new IsolatedDbShadowContractError('DATABASE_URL must target an explicit loopback address');
  }
  if (!url.username) throw new IsolatedDbShadowContractError('DATABASE_URL must include a dedicated user');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new IsolatedDbShadowContractError('DATABASE_URL must include a dedicated database name');
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new IsolatedDbShadowContractError('DATABASE_URL port must be between 1024 and 65535');
  }
  if (url.searchParams.get('sslmode') && url.searchParams.get('sslmode') !== 'disable') {
    throw new IsolatedDbShadowContractError('loopback isolated DB may only use sslmode=disable');
  }
  return {
    normalized: url.toString(),
    host: host === '127.0.0.1' ? '127.0.0.1' : '::1',
    port,
    database,
    user: decodeURIComponent(url.username),
  };
}

/** Validate the environment before importing pg or opening any socket. */
export function resolveIsolatedDbShadowConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): IsolatedDbShadowConfig {
  if (required(env, 'TOWER_RUN_MODE') !== 'shadow') {
    throw new IsolatedDbShadowContractError('TOWER_RUN_MODE must equal shadow');
  }
  if (required(env, 'TOWER_SHADOW_PROFILE') !== 'isolated-db') {
    throw new IsolatedDbShadowContractError('TOWER_SHADOW_PROFILE must equal isolated-db');
  }
  if (env.HOST?.trim() || env.PORT?.trim() || env.PUBLIC_URL?.trim() || env.SHARE_PUBLIC_URL?.trim()) {
    throw new IsolatedDbShadowContractError('HTTP bind and public URL variables must be unset');
  }

  const leaked = Object.entries(env)
    .filter(([name, value]) => Boolean(value?.trim())
      && !ALLOWED_CREDENTIAL_ENV.has(name)
      && (EXPLICIT_CREDENTIAL_ENV.has(name) || CREDENTIAL_ENV.test(name)))
    .map(([name]) => name)
    .sort();
  if (leaked.length > 0) {
    throw new IsolatedDbShadowContractError(`non-database credentials must be absent: ${leaked.join(', ')}`);
  }

  const shadowRootRaw = required(env, 'TOWER_SHADOW_ROOT');
  if (!path.isAbsolute(shadowRootRaw)) {
    throw new IsolatedDbShadowContractError('TOWER_SHADOW_ROOT must be an absolute path');
  }
  const shadowRoot = path.resolve(shadowRootRaw);
  const marker = required(env, 'TOWER_ISOLATED_DB_MARKER');
  if (!/^[a-z0-9][a-z0-9_-]{7,63}$/.test(marker)) {
    throw new IsolatedDbShadowContractError('TOWER_ISOLATED_DB_MARKER must be a stable 8-64 character slug');
  }

  const parsed = parseLoopbackDatabaseUrl(required(env, 'DATABASE_URL'));
  const expectedDatabase = `tower_shadow_${marker.replace(/-/g, '_')}`;
  const expectedUser = `tower_shadow_${marker.replace(/-/g, '_')}`;
  if (parsed.database !== expectedDatabase || parsed.user !== expectedUser) {
    throw new IsolatedDbShadowContractError(
      `database and user must both equal ${expectedDatabase}`,
    );
  }

  const migrationDirRaw = env.TOWER_MIGRATION_DIR?.trim()
    || path.join(cwd, 'packages', 'backend', 'db', 'migrations');
  if (!path.isAbsolute(migrationDirRaw)) {
    throw new IsolatedDbShadowContractError('TOWER_MIGRATION_DIR must be absolute when provided');
  }

  return {
    runMode: 'shadow',
    profile: 'isolated-db',
    shadowRoot,
    databaseUrl: parsed.normalized,
    databaseHost: parsed.host,
    databasePort: parsed.port,
    databaseName: parsed.database,
    databaseUser: parsed.user,
    marker,
    migrationDir: path.resolve(migrationDirRaw),
  };
}
