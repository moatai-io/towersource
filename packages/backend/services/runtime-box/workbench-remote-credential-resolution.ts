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
  const apiKeys = await resolveRuntimeBoxApiKeyEnv({
    projectId: input.projectId,
    userId: input.userId,
    existingEnv: input.request.env,
  });
  const profiles = await resolveRuntimeBoxCredentialProfileEnv({
    projectId: input.projectId,
    userId: input.userId,
    existingEnv: apiKeys.env,
  });
  if (profiles.materializeFiles.length > 0) {
    throw new Error('REMOTE_FILE_CREDENTIALS_NOT_SUPPORTED: keep this Job on Local Runtime');
  }
  const env = { ...profiles.env };
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
