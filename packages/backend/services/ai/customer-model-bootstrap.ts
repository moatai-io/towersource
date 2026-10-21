/** First-connection defaults only. Team /models remains the visibility authority.
 * Later operator choices are never overwritten by catalog refresh or re-entry.
 */
import type { PiModelEntry } from '../../config.js';
import { normalizeLiteLLMModels } from './litellm-model-catalog.js';

type ModelsFile = ReturnType<typeof import('../../config.js').loadModelsFile>;
export const customerAiDefaults = {
  version: 1,
  core: '~deepseek/deepseek-pro-latest',
  lite: '~deepseek/deepseek-pro-latest',
  requiredModels: ['gpt-6.1-sol', '~deepseek/deepseek-pro-latest', 'z-ai/glm-5.3'],
} as const;
export interface CustomerAiBootstrapReceipt {
  version: 1;
  initializedAt: string;
  coreModel: string;
  liteModel: string;
  visibleModelIds: string[];
}

export type CustomerAiProfile = 'gpt-only';
export function initializeCustomerAiDefaults(file: ModelsFile, teamModels: unknown, initializedAt: string, profile?: CustomerAiProfile): {
  file: ModelsFile; initialized: boolean;
} {
  // A prior VM setup (including an operator's own mapping) wins. Never rotate
  // settings just because a provisioning job or setup button is run again.
  if (file.customerAiBootstrap || file.inferenceProviders?.['litellm-responses'] || file.inferenceProviders?.litellm) {
    return { file: structuredClone(file), initialized: false };
  }
  const discovered = normalizeLiteLLMModels(teamModels);
  const visible = new Set(discovered.map(row => row.modelId));
  if (profile !== undefined && profile !== 'gpt-only') throw new Error('Customer AI profile invalid');
  const requiredModels = profile === 'gpt-only' ? ['gpt-6.1-sol'] : customerAiDefaults.requiredModels;
  if (!requiredModels.every(id => visible.has(id))) throw new Error('Customer Team catalog is missing required models');
  if (!Number.isFinite(Date.parse(initializedAt))) throw new Error('Invalid customer model initialization time');
  const next = structuredClone(file);
  const previousModels = new Map(next.pi.filter(row => row.provider === 'litellm-responses' || row.provider === 'litellm').map(row => [row.modelId, row]));
  next.pi = next.pi.filter(row => row.provider !== 'litellm-responses' && row.provider !== 'litellm');
  for (const row of discovered) {
    const previous = previousModels.get(row.modelId);
    const model: PiModelEntry = {
      ...previous,
      provider: 'litellm-responses', modelId: row.modelId, name: previous?.name || row.modelId,
      enabled: true, hidden: false, selectable: true, modelKind: 'direct', api: 'openai-responses',
      reasoning: previous?.reasoning ?? true,
      contextWindow: row.contextWindow ?? previous?.contextWindow ?? 128_000,
      maxTokens: row.maxTokens ?? previous?.maxTokens ?? 16_000,
      catalogOwnedBy: row.ownedBy,
      catalogInputCostPerToken: row.inputCostPerToken,
      catalogOutputCostPerToken: row.outputCostPerToken,
      discoveredAt: previous?.discoveredAt ?? initializedAt,
      lastSeenAt: initializedAt,
      reasoningEfforts: previous?.reasoningEfforts ?? ['low', 'medium', 'high'],
      defaultReasoning: previous?.defaultReasoning ?? 'medium',
    };
    next.pi.push(model);
  }
  const core = 'litellm-responses/' + (profile === 'gpt-only' ? 'gpt-6.1-sol' : customerAiDefaults.core);
  const lite = 'litellm-responses/' + (profile === 'gpt-only' ? 'gpt-6.1-sol' : customerAiDefaults.lite);
  next.defaults = { ...next.defaults, session: core, ai_task: lite, ai_reply: lite };
  const policies = { ...next.modelPolicies?.policies };
  for (const id of ['medium', 'high', 'extra-high', 'max', 'ultra', 'background']) {
    policies[id] = { ...policies[id], model: core, effort: policies[id]?.effort ?? 'medium', ...(id === 'ultra' && !policies[id] ? { enabled: false } : {}) };
  }
  for (const id of ['low', 'title', 'summary']) {
    policies[id] = { ...policies[id], model: lite, effort: policies[id]?.effort ?? 'low' };
  }
  next.modelPolicies = { revision: (next.modelPolicies?.revision ?? 0) + 1, policies };
  next.customerAiBootstrap = { version: 1, initializedAt, coreModel: core, liteModel: lite, visibleModelIds: [...visible].sort() };
  next.litellmCatalog = { syncedAt: initializedAt };
  return { file: next, initialized: true };
}
