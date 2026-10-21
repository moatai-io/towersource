import { loadModelsFile, type ReasoningEffort } from '../../config.js';
import { isReasoningEffort, reasoningEffortsForModel } from '../../services/model-policy/reasoning-efforts.js';

/** Resolve against the current VM registry at each turn, not a cached session level. */
export function resolveTurnReasoning(
  model: { provider: string; id: string } | undefined,
  effort?: string,
): ReasoningEffort {
  const supported = reasoningEffortsForModel(model?.provider, model?.id);
  if (!model && isReasoningEffort(effort)) return effort;
  if (isReasoningEffort(effort) && supported.includes(effort)) return effort;
  const configured = loadModelsFile().pi.find(entry => entry.provider === model?.provider && entry.modelId === model?.id)?.defaultReasoning;
  if (configured && supported.includes(configured)) return configured;
  return supported.includes('medium') ? 'medium' : supported[0] ?? 'medium';
}
