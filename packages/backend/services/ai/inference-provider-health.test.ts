import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeConfiguredInferenceProviders } from './inference-provider-health.js';
import type { InferenceProviderReadiness } from './inference-provider-readiness.js';

const originalOpenRouter = process.env.OPENROUTER_API_KEY;
const originalBaseUrl = process.env.OPENROUTER_BASE_URL;

const readiness: InferenceProviderReadiness = {
  status: 'ready',
  defaultModel: 'openrouter/auto',
  readyProviders: ['openrouter'],
  configuredProviders: ['openrouter'],
  reason: 'ready',
  nextAction: 'No action required.',
};

afterEach(() => {
  vi.restoreAllMocks();
  if (originalOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalOpenRouter;
  if (originalBaseUrl === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = originalBaseUrl;
});

describe('inference provider health', () => {
  it('authenticates OpenRouter with the key endpoint instead of the public models endpoint', async () => {
    process.env.OPENROUTER_API_KEY = 'test-redacted';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1/';
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

    const result = await probeConfiguredInferenceProviders(readiness, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.objectContaining({
      headers: { Authorization: 'Bearer test-redacted' },
    }));
    expect(result).toMatchObject({ status: 'ready', checkedProviders: ['openrouter'], failedProviders: [] });
  });

  it('marks readiness invalid when OpenRouter rejects the credential', async () => {
    process.env.OPENROUTER_API_KEY = 'test-redacted';
    const fetchImpl = vi.fn(async () => new Response('{"error":"User not found"}', { status: 401 })) as unknown as typeof fetch;

    const result = await probeConfiguredInferenceProviders(readiness, fetchImpl);

    expect(result).toMatchObject({
      status: 'invalid',
      reason: 'provider_auth_failed',
      checkedProviders: ['openrouter'],
      failedProviders: [{ provider: 'openrouter', reason: 'authentication rejected (HTTP 401)' }],
    });
  });
});
