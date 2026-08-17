/**
 * Owns: Secret-presence-only construction of configured voice providers.
 * Public API: buildLiveKitAccessFromEnv. See README.md.
 */

import { resolveProjectApiKeySecretValue } from '../credential-vault/credential-vault-service.js';
import { createLiveKitAccessFactory } from './livekit-access.js';

/** Return a LiveKit token factory only when all required server-side values are materialized. */
export function buildLiveKitAccessFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const url = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return undefined;
  return createLiveKitAccessFactory({ url, apiKey, apiSecret });
}

/** Resolve project-granted LiveKit fields for one authenticated token request. */
export async function buildLiveKitAccessFromProjectVault(input: { projectId: string; userId: number }) {
  const targetType = 'voice_livekit_token';
  const [url, apiKey, apiSecret] = await Promise.all([
    resolveProjectApiKeySecretValue({ ...input, envName: 'LIVEKIT_URL', targetType }),
    resolveProjectApiKeySecretValue({ ...input, envName: 'LIVEKIT_API_KEY', targetType }),
    resolveProjectApiKeySecretValue({ ...input, envName: 'LIVEKIT_API_SECRET', targetType }),
  ]);
  if (!url || !apiKey || !apiSecret) return undefined;
  return createLiveKitAccessFactory({
    url: url.value,
    apiKey: apiKey.value,
    apiSecret: apiSecret.value,
    agentName: 'tower-korean-voice',
  });
}
