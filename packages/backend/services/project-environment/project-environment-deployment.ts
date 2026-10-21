/** Resolve the stable Tower execution deployment identity without coupling callers to an executor implementation. */
export function resolveProjectEnvironmentDeploymentId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TOWER_DEPLOYMENT_ID?.trim();
  if (explicit) return explicit;
  if (env.PORT?.trim() === '32355') return 'development';
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}
