import { loadModelsFile, type ReasoningEffort } from '../../config.js';

export const PRODUCT_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PRODUCT_REASONING_SET = new Set<string>(PRODUCT_REASONING_EFFORTS);

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && PRODUCT_REASONING_SET.has(value);
}

export function reasoningEffortsForModel(provider: string | undefined, modelId: string | undefined): readonly ReasoningEffort[] {
  const entry = loadModelsFile().pi.find(model => model.provider === provider && model.modelId === modelId);
  if (!entry?.reasoning) return [];
  const configured = entry.reasoningEfforts?.filter(isReasoningEffort);
  return configured?.length ? configured : ['low', 'medium', 'high'];
}

export function resolveConfiguredModelId(modelChoice: string | undefined): string | undefined {
  if (!modelChoice) return loadModelsFile().defaults?.session;
  if (modelChoice === 'preset/core' || modelChoice === 'policy/core') return loadModelsFile().defaults?.session;
  if (modelChoice === 'preset/lite' || modelChoice === 'policy/lite') return loadModelsFile().defaults?.ai_task;
  return modelChoice.replace(/^pi:/, '');
}

export function reasoningEffortsForChoice(modelChoice: string | undefined): readonly ReasoningEffort[] {
  const resolved = resolveConfiguredModelId(modelChoice);
  if (!resolved?.includes('/')) return [];
  const [provider, ...parts] = resolved.split('/');
  return reasoningEffortsForModel(provider, parts.join('/'));
}
