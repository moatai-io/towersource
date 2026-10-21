export const JEV_SESSION_NAVIGATOR_ENV = 'TOWER_JEV_SESSION_NAVIGATOR_ENABLED';

/** Research Alpha: disabled on every VM unless explicitly opted in. */
export function isJevSessionNavigatorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_SESSION_NAVIGATOR_ENV] === 'true';
}
