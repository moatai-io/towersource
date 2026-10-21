import type { InferenceProviderReadiness } from './inference-provider-readiness.js';
import { resolveConfiguredInferenceProviderSecret } from './inference-provider-setup.js';

export type InferenceProviderHealth = InferenceProviderReadiness & {
  checkedProviders: string[];
  failedProviders: Array<{ provider: string; reason: string }>;
};

type ProviderCredential = { apiKey: string; baseUrl: string };

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/$/, '');
}

async function resolveCredential(provider: string): Promise<ProviderCredential | null> {
  if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
    return {
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
    };
  }
  const saved = await resolveConfiguredInferenceProviderSecret(provider, 0);
  return saved ? { ...saved, baseUrl: 'https://openrouter.ai/api/v1' } : null;
}

export async function probeConfiguredInferenceProviders(
  readiness: InferenceProviderReadiness,
  fetchImpl: typeof fetch = fetch,
): Promise<InferenceProviderHealth> {
  const checkedProviders: string[] = [];
  const failedProviders: Array<{ provider: string; reason: string }> = [];

  for (const provider of readiness.readyProviders) {
    if (provider !== 'openrouter') continue;
    const credential = await resolveCredential(provider);
    if (!credential?.apiKey) continue;
    checkedProviders.push(provider);
    try {
      const response = await fetchImpl(`${trimBaseUrl(credential.baseUrl)}/key`, {
        headers: { Authorization: `Bearer ${credential.apiKey.trim()}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        failedProviders.push({ provider, reason: `authentication rejected (HTTP ${response.status})` });
      }
    } catch (error) {
      failedProviders.push({ provider, reason: `health check failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  if (failedProviders.length === 0) return { ...readiness, checkedProviders, failedProviders };
  return {
    ...readiness,
    status: 'invalid',
    reason: 'provider_auth_failed',
    nextAction: `Fix provider authentication: ${failedProviders.map(item => `${item.provider} (${item.reason})`).join(', ')}.`,
    checkedProviders,
    failedProviders,
  };
}
