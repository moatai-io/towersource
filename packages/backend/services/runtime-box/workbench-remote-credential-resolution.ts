/**
 * Owns: Command-scoped Credential Vault resolution for Remote Workbench Jobs.
 * Public API: resolveRemoteWorkbenchCredentialEnv.
 *
 * Reuses the same Project/user authority and risky-command suppression as Local Runtime.
 * File materialization and CLI login bundles remain unsupported because Worker-local
 * ephemeral file delivery has a different cleanup contract from environment values.
 */

import {
  resolveProjectCredentialSecretValue,
  resolveRuntimeBoxApiKeyEnv,
  resolveRuntimeBoxCredentialProfileEnv,
} from '../credential-vault/credential-vault-service.js';
import { shouldSuppressCredentialEnv } from './command-classifier.js';
import { commandRequestsGwsConnectionId, selectProjectGwsConnection } from './runtime-box-manager.js';
import type { WorkbenchExecutionRequest } from './workbench-execution-broker.js';

const PROVIDER_ENV_HINTS: Array<{ pattern: RegExp; prefixes: string[] }> = [
  { pattern: /(?:^|[^a-z0-9])(openai|gpt[-_ ]?image|chatgpt)(?:[^a-z0-9]|$)/i, prefixes: ['OPENAI_'] },
  { pattern: /\b(apify)\b/i, prefixes: ['APIFY_'] },
  { pattern: /\b(firecrawl)\b/i, prefixes: ['FIRECRAWL_'] },
  { pattern: /\b(naver)\b/i, prefixes: ['NAVER_'] },
  { pattern: /\b(notion)\b/i, prefixes: ['NOTION_'] },
  { pattern: /\b(tiro)\b/i, prefixes: ['TIRO_'] },
  { pattern: /\b(frappe)\b/i, prefixes: ['FRAPPE_'] },
  { pattern: /\b(n8n)\b/i, prefixes: ['N8N_'] },
  { pattern: /\b(agent[_ -]?store)\b/i, prefixes: ['AGENT_STORE_'] },
  { pattern: /\b(higgsfield)\b/i, prefixes: ['HIGGSFIELD_'] },
];

/** Infer the narrow environment scope explicitly requested by one command. */
export function requestedCredentialEnvNames(command: string): Set<string> {
  const requested = new Set<string>();
  for (const match of command.matchAll(/(?:\$\{?|process\.env\.|os\.getenv\(["'])([A-Z][A-Z0-9_]{1,63})/g)) requested.add(match[1]);
  for (const hint of PROVIDER_ENV_HINTS) if (hint.pattern.test(command)) hint.prefixes.forEach(prefix => requested.add(prefix));
  return requested;
}

function filterCredentialEnv(env: Record<string, string>, requested: Set<string>, callerEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => Object.prototype.hasOwnProperty.call(callerEnv, key)
    || requested.has(key)
    || [...requested].some(prefix => prefix.endsWith('_') && key.startsWith(prefix))));
}

export interface RemoteWorkbenchCredentialResolution {
  request: WorkbenchExecutionRequest;
  environmentKeys: string[];
  suppressed: boolean;
  suppressReason?: string;
}

/** Resolve current Vault grants immediately before a Remote Job is enqueued. */
export async function resolveRemoteWorkbenchCredentialEnv(input: {
  projectId: string;
  userId: number;
  request: WorkbenchExecutionRequest;
}): Promise<RemoteWorkbenchCredentialResolution> {
  const suppression = shouldSuppressCredentialEnv(input.request.command);
  if (suppression.suppress) {
    return {
      request: { ...input.request, env: input.request.env ? { ...input.request.env } : undefined },
      environmentKeys: Object.keys(input.request.env ?? {}).sort(),
      suppressed: true,
      suppressReason: suppression.reason,
    };
  }
  const callerEnv = input.request.env ?? {};
  const requested = requestedCredentialEnvNames(input.request.command);
  const apiKeys = await resolveRuntimeBoxApiKeyEnv({
    projectId: input.projectId,
    userId: input.userId,
    existingEnv: callerEnv,
  });
  const selectedApiEnv = filterCredentialEnv(apiKeys.env, requested, callerEnv);
  const profiles = await resolveRuntimeBoxCredentialProfileEnv({
    projectId: input.projectId,
    userId: input.userId,
    existingEnv: selectedApiEnv,
  });
  const requestedFiles = profiles.materializeFiles.filter(file => requested.has(file.envName));
  if (requestedFiles.length > 0) {
    throw new Error('REMOTE_FILE_CREDENTIALS_NOT_SUPPORTED: requested profile needs Worker-local file materialization');
  }
  const env = { ...callerEnv, ...selectedApiEnv, ...filterCredentialEnv(profiles.env, requested, callerEnv) };
  if (/(^|[;&|()\s])gws\s+/.test(input.request.command)) {
    env.SSL_CERT_FILE = '/worker-project/.tower-worker-tools/ca-certificates.crt';
    const selected = await selectProjectGwsConnection({
      projectId: input.projectId,
      requestedCredentialId: commandRequestsGwsConnectionId(input.request.command),
    });
    const gws = await resolveProjectCredentialSecretValue({
      projectId: input.projectId,
      userId: input.userId,
      credentialId: selected.id,
      kind: 'gws',
      provider: 'google',
      targetType: 'remote_worker_gws_config',
    });
    if (!gws) throw new Error(`PROJECT_GWS_CREDENTIAL_NOT_AVAILABLE: ${selected.id} cannot be resolved for Worker use`);
    env.TOWER_REMOTE_GWS_CONFIG_B64 = gws.value;
    env.TOWER_REMOTE_GWS_USER_ID = String(input.userId);
  }
  return {
    request: { ...input.request, env },
    environmentKeys: Object.keys(env).sort(),
    suppressed: false,
  };
}
