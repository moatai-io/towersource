import { loadModelsFile, getModelDefaults } from '../../config.js';

export type InferenceProviderReadiness = {
  status: 'ready' | 'setup_required' | 'invalid';
  defaultModel: string;
  readyProviders: string[];
  configuredProviders: string[];
  reason: 'ready' | 'no_provider' | 'default_unavailable';
  nextAction: string;
};

function providerReady(provider: string, vaultConfigured: Set<string>): boolean {
  if (provider === 'openrouter') return Boolean(process.env.OPENROUTER_API_KEY) || vaultConfigured.has(provider);
  if (provider === 'openai-responses-compatible') return Boolean(process.env.OPENAI_RESPONSES_API_KEY) || vaultConfigured.has(provider);
  if (provider === 'litellm' || provider === 'litellm-responses') return Boolean(process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY);
  if (provider === 'codex-lb') return Boolean(process.env.CODEX_LB_BASE_URL && process.env.CODEX_LB_API_KEY);
  if (provider === 'local') return process.env.LOCAL_LLM_ENABLED === 'true';
  if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider.startsWith('azure-openai-responses')) return Boolean(process.env.AZURE_OPENAI_API_KEY);
  return false;
}

export function getInferenceProviderReadiness(): InferenceProviderReadiness {
  const models = loadModelsFile().pi.filter(model => model.enabled !== false);
  const configuredProviders = [...new Set(models.map(model => model.provider))];
  const vaultConfigured = new Set(Object.keys(loadModelsFile().inferenceProviders ?? {}));
  const readyProviders = configuredProviders.filter(provider => providerReady(provider, vaultConfigured));
  const defaultModel = getModelDefaults().session;
  const defaultProvider = defaultModel.split('/')[0];

  if (readyProviders.length === 0) {
    return {
      status: 'setup_required', defaultModel, readyProviders, configuredProviders,
      reason: 'no_provider',
      nextAction: 'Configure OPENROUTER_API_KEY or OPENAI_RESPONSES_API_KEY, then run npm run provider:doctor.',
    };
  }
  if (!readyProviders.includes(defaultProvider)) {
    return {
      status: 'invalid', defaultModel, readyProviders, configuredProviders,
      reason: 'default_unavailable',
      nextAction: `Choose a default model from a ready provider: ${readyProviders.join(', ')}.`,
    };
  }
  return {
    status: 'ready', defaultModel, readyProviders, configuredProviders,
    reason: 'ready', nextAction: 'No action required.',
  };
}
