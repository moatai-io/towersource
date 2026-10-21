/** Non-secret, per-process connection budget. Values are read when the pool is created. */
export function resolvePgPoolConfig(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.TOWER_PG_POOL_MAX ?? '80';
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 1000) {
    throw new Error('TOWER_PG_POOL_MAX must be an integer between 1 and 1000');
  }
  const name = env.TOWER_PG_APPLICATION_NAME ?? (env.NODE_ENV === 'production' ? 'tower-prod' : 'tower-dev');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) {
    throw new Error('TOWER_PG_APPLICATION_NAME must be 1-63 ASCII letters, digits, dots, underscores or hyphens');
  }
  return { max: Number(raw), application_name: name };
}
