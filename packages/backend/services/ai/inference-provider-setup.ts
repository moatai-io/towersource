import { getModelDefaults, loadModelsFile, saveModelsFile, type PiModelEntry } from '../../config.js';
import { getSecret, setSecret } from '../secret/secret-store.js';

export type PublicInferenceProvider = 'openrouter' | 'openai-responses-compatible';

const PROVIDERS: Record<PublicInferenceProvider, {
  secretName: string;
  defaultBaseUrl: string;
  defaultModel: string;
  displayName: string;
  badge: string;
  api: string;
}> = {
  openrouter: {
    secretName: 'TOWER_INFERENCE_OPENROUTER_API_KEY',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    displayName: 'OpenRouter Auto',
    badge: 'OR',
    api: 'openai-completions',
  },
  'openai-responses-compatible': {
    secretName: 'TOWER_INFERENCE_RESPONSES_API_KEY',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6-terra',
    displayName: 'OpenAI-compatible Responses',
    badge: 'API',
    api: 'openai-responses',
  },
};

function providerConfig(provider: string) {
  const config = PROVIDERS[provider as PublicInferenceProvider];
  if (!config) throw new Error('Unsupported inference provider');
  return config;
}

function normalizedBaseUrl(value: string | undefined, fallback: string): string {
  const url = (value || fallback).trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Base URL must start with http:// or https://');
  return url;
}

export async function probeInferenceProvider(input: {
  provider: PublicInferenceProvider;
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
}): Promise<{ ok: true; provider: PublicInferenceProvider; modelId: string; latencyMs: number }> {
  const config = providerConfig(input.provider);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error('API key is required');
  const baseUrl = normalizedBaseUrl(input.baseUrl, config.defaultBaseUrl);
  const modelId = (input.modelId || config.defaultModel).trim();
  if (!modelId) throw new Error('Model ID is required');
  const startedAt = Date.now();
  const response = input.provider === 'openrouter'
    ? await fetch(`${baseUrl}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) })
    : await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, input: 'Reply with OK.', max_output_tokens: 8 }),
        signal: AbortSignal.timeout(30_000),
      });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Provider rejected the connection (${response.status})${text ? `: ${text.slice(0, 240)}` : ''}`);
  }
  return { ok: true, provider: input.provider, modelId, latencyMs: Date.now() - startedAt };
}

function publicModelEntry(provider: PublicInferenceProvider, modelId: string): PiModelEntry {
  const config = providerConfig(provider);
  return {
    provider,
    modelId,
    name: provider === 'openrouter' && modelId === config.defaultModel ? config.displayName : modelId,
    badge: config.badge,
    enabled: true,
    api: config.api,
    reasoning: provider === 'openai-responses-compatible',
    contextWindow: 200000,
    maxTokens: 64000,
    roles: ['full', 'managed', 'standalone'],
  };
}

export async function configureInferenceProvider(input: {
  provider: PublicInferenceProvider;
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
  actorUserId: number;
}): Promise<{ provider: PublicInferenceProvider; model: string; latencyMs: number }> {
  const config = providerConfig(input.provider);
  const baseUrl = normalizedBaseUrl(input.baseUrl, config.defaultBaseUrl);
  const modelId = (input.modelId || config.defaultModel).trim();
  const probe = await probeInferenceProvider({ ...input, baseUrl, modelId });
  await setSecret({
    name: config.secretName,
    value: input.apiKey.trim(),
    scope: 'global',
    description: `Tower inference provider: ${input.provider}`,
    createdBy: input.actorUserId,
  });
  const file = loadModelsFile();
  const model = publicModelEntry(input.provider, modelId);
  const pi = file.pi.some(item => item.provider === model.provider && item.modelId === model.modelId)
    ? file.pi.map(item => item.provider === model.provider && item.modelId === model.modelId ? { ...item, ...model, enabled: true } : item)
    : [...file.pi, model];
  const modelSpec = `${input.provider}/${modelId}`;
  saveModelsFile({
    ...file,
    pi,
    defaults: { session: modelSpec, ai_reply: modelSpec, ai_task: modelSpec },
    inferenceProviders: {
      ...(file.inferenceProviders ?? {}),
      [input.provider]: { baseUrl, secretName: config.secretName, configuredAt: new Date().toISOString() },
    },
  });
  return { provider: input.provider, model: modelSpec, latencyMs: probe.latencyMs };
}

export async function resolveConfiguredInferenceProviderSecret(provider: string, userId: number): Promise<{ apiKey: string; baseUrl: string } | null> {
  const file = loadModelsFile();
  const saved = file.inferenceProviders?.[provider];
  if (!saved?.secretName) return null;
  try {
    return { apiKey: await getSecret(saved.secretName, userId), baseUrl: saved.baseUrl };
  } catch {
    return null;
  }
}

export function inferenceSetupStatus() {
  const file = loadModelsFile();
  const defaultModel = getModelDefaults().session;
  return {
    defaultModel,
    providers: (Object.keys(PROVIDERS) as PublicInferenceProvider[]).map(provider => ({
      id: provider,
      configured: Boolean(file.inferenceProviders?.[provider]?.secretName),
      baseUrl: file.inferenceProviders?.[provider]?.baseUrl ?? PROVIDERS[provider].defaultBaseUrl,
      defaultModel: PROVIDERS[provider].defaultModel,
    })),
  };
}
