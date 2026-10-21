import { createPrivateKey } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, statSync, realpathSync, readSync } from 'node:fs';
import path from 'node:path';
import { FeedbackError, tokenSchema } from './contract.js';

export interface GitHubAppConfig { appId: string; installationId: string; repositoryId: number; repository: string; privateKey: string }
export interface ClientConfig { origin: string; token: string }
export function intakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.TOWER_FEEDBACK_INTAKE_ENABLED === 'true'; }
export function clientEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.TOWER_FEEDBACK_CLIENT_ENABLED === 'true'; }
export function deliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return intakeEnabled(env) && env.TOWER_FEEDBACK_DELIVERY_ENABLED === 'true' && env.TOWER_CANDIDATE_PASSIVE_MODE !== 'true';
}
export function clientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  try {
    const url = new URL(env.TOWER_FEEDBACK_INTAKE_ORIGIN ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return { origin: url.origin, token: tokenSchema.parse(env.TOWER_FEEDBACK_CLIENT_TOKEN) };
  } catch { throw new FeedbackError('feedback_client_not_configured'); }
}
// Backend-only secret input, never a Project Credential or customer setting.
// File wins over inline PEM, including when invalid: never silently fall back.
function githubPrivateKey(env: NodeJS.ProcessEnv): string {
  if (env.TOWER_FEEDBACK_GITHUB_KEY_FILE === undefined) return env.TOWER_FEEDBACK_GITHUB_PRIVATE_KEY ?? '';
  if (!deliveryEnabled(env) || clientEnabled(env)) throw new Error();
  const filename = env.TOWER_FEEDBACK_GITHUB_KEY_FILE;
  if (!filename || !path.isAbsolute(filename) || path.normalize(filename) !== filename
    || realpathSync(filename) !== filename) throw new Error();
  const ownerAllowed = (uid: number) => uid === 0 || uid === process.geteuid?.();
  // Canonical path rejects symlinks in any component. The operator must also
  // keep ancestor directories under trusted control (no untrusted rename).
  const parent = statSync(path.dirname(filename));
  if (!parent.isDirectory() || !ownerAllowed(parent.uid) || (parent.mode & 0o7777) !== 0o700) throw new Error();
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !ownerAllowed(stat.uid) || stat.nlink !== 1
      || ![0o400, 0o600].includes(stat.mode & 0o7777) || stat.size < 1 || stat.size > 32768) throw new Error();
    // Bounded read even if a trusted owner changes the file after fstat.
    const bytes = Buffer.alloc(32769);
    let length = 0; let count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > 32768) throw new Error();
    return bytes.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
}
export function githubConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  const appId = env.TOWER_FEEDBACK_GITHUB_APP_ID ?? '';
  const installationId = env.TOWER_FEEDBACK_GITHUB_INSTALLATION_ID ?? '';
  const repositoryId = Number(env.TOWER_FEEDBACK_GITHUB_REPOSITORY_ID);
  const repository = env.TOWER_FEEDBACK_GITHUB_REPOSITORY ?? '';
  try {
    const privateKey = githubPrivateKey(env);
    if (!/^[1-9][0-9]*$/.test(appId) || !/^[1-9][0-9]*$/.test(installationId)
      || !Number.isSafeInteger(repositoryId) || repositoryId < 1
      || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository)) throw new Error();
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
    return { appId, installationId, repositoryId, repository, privateKey };
  } catch { throw new FeedbackError('feedback_github_not_configured'); }
}
