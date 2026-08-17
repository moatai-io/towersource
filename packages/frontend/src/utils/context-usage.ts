import type { ChatMessage, CostInfo } from '../stores/chat-store';

const FALLBACK_CONTEXT_WINDOW = 200_000;

export function fmtTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export interface ContextUsageStat {
  contextInput: number;
  contextOutput: number;
  maxTokens: number;
  contextUsed: number;
  hasContextMetric: boolean;
  contextPct: number;
  contextRemaining: number;
  userMsgCount: number;
}

/**
 * Computes the UI stat-line view of the active session's context usage.
 * Live engine metrics win; after reload, fall back to the last assistant
 * message's persisted context metadata and model registry window.
 */
export function computeContextUsageStat(args: {
  cost: CostInfo;
  messages: ChatMessage[];
  modelContextWindow?: number;
}): ContextUsageStat {
  const { cost, messages, modelContextWindow } = args;
  const estimatedCostInput = Number((cost as any).contextEstimatedTokens || 0);
  const rawCostInput = cost.contextInputTokens || 0;
  let contextInput = estimatedCostInput > 0 && rawCostInput > 0
    ? Math.min(estimatedCostInput, rawCostInput)
    : (estimatedCostInput || rawCostInput);
  let contextOutput = cost.contextOutputTokens || 0;
  let maxTokens = cost.contextWindowSize || modelContextWindow || 0;

  if (contextInput === 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant') {
        const estimated = Number(m.metadata?.usage?.context_estimated_tokens || m.contextEstimatedTokens || 0);
        const raw = Number(m.metadata?.usage?.context_input_tokens || m.inputTokens || 0);
        const candidateInput = estimated > 0 && raw > 0 ? Math.min(estimated, raw) : (estimated || raw);
        if (candidateInput > 0) {
          contextInput = candidateInput;
          contextOutput = m.outputTokens || 0;
          maxTokens = maxTokens || m.contextWindowSize || Number(m.metadata?.usage?.context_window_size || 0);
          break;
        }
      }
    }
  }

  if (maxTokens === 0 && contextInput > 0) maxTokens = FALLBACK_CONTEXT_WINDOW;
  if (maxTokens > 0 && contextInput > maxTokens) contextInput = maxTokens;

  const contextUsed = contextInput;
  const hasContextMetric = contextUsed > 0 && maxTokens > 0;
  const contextPct = hasContextMetric ? Math.min((contextUsed / maxTokens) * 100, 100) : 0;
  const contextRemaining = hasContextMetric ? Math.max(maxTokens - contextUsed, 0) : 0;
  const userMsgCount = messages.filter((m) => (
    m.role === 'user'
    && !m.metadata?.hidden
    && !m.parentToolUseId
    && (m.metadata as any)?.sourceType !== 'agent_wake'
    && (m.metadata as any)?.sourceType !== 'agent_send'
    && (m.metadata as any)?.sourceType !== 'agent_spawn'
    && !(m.metadata as any)?.agentWake
    && !(m.metadata as any)?.agentSend
  )).length;

  return {
    contextInput,
    contextOutput,
    maxTokens,
    contextUsed,
    hasContextMetric,
    contextPct,
    contextRemaining,
    userMsgCount,
  };
}
