import { newerContextSnapshot, normalizeContextPressure, normalizeContextMeasurement, newerContextMeasurement, type ContextMeasurement } from './context-measurement';
import type { ChatMessage, CostInfo } from '../stores/chat-store';



export function fmtTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export interface ContextUsageStat {
  contextInput: number;
  usesCompactionBudget: boolean;
  pressure?: import('./context-measurement').ContextPressure;
  pressurePct?: number;
  isEstimated: boolean;
  measurement?: ContextMeasurement;
  hasKnownWindow: boolean;
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
  let snapshot = cost.contextSnapshot;
  let measurement: ContextMeasurement | undefined = cost.contextMeasurement || normalizeContextMeasurement({
    requestId: 'legacy-live', measuredAt: 0, actual: cost.contextInputTokens,
    estimated: cost.contextEstimatedTokens, window: cost.contextWindowSize || modelContextWindow,
    compacted: cost.contextCompacted, compactThreshold: cost.compactThresholdTokens,
  });
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const usage = m.metadata?.usage || {};
    const candidate = normalizeContextMeasurement({
      requestId: m.id, measuredAt: Number(usage.context_measured_at) || m.timestamp || 0,
      actual: usage.context_input_tokens, estimated: usage.context_estimated_tokens || m.contextEstimatedTokens,
      compactThreshold: usage.compact_threshold_tokens,
      window: usage.context_window_size || m.contextWindowSize || modelContextWindow,
      compacted: usage.context_compacted === true || m.contextCompacted === true,
      uncached: m.contextWindowSize || Number(usage.cache_read_tokens) > 0 || Number(usage.cache_creation_tokens) > 0 ? m.inputTokens : undefined, cacheRead: usage.cache_read_tokens, cacheWrite: usage.cache_creation_tokens,
    });
    snapshot = newerContextSnapshot(snapshot, usage.context_snapshot);
    // Legacy live metrics have no timestamp: retain them until timestamped request updates arrive.
    if (measurement?.requestId === 'legacy-live') continue;
    measurement = newerContextMeasurement(measurement, candidate);
  }
  const pressure = normalizeContextPressure(snapshot);
  const contextInput = measurement?.inputTokens || 0;
  const isEstimated = !!measurement && measurement.source !== 'provider';
  // Model capacity remains model capacity for every existing consumer (including handoff).
  const usesCompactionBudget = Boolean(pressure);
  const maxTokens = measurement?.windowTokens || 0;
  const contextOutput = cost.contextOutputTokens || messages.find(m => m.id === measurement?.requestId)?.outputTokens || 0;
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
    usesCompactionBudget,
    pressure,
    pressurePct: pressure ? Math.max(0, Math.min(100, pressure.tokens / pressure.thresholdTokens * 100)) : undefined,
    isEstimated,
    measurement,
    hasKnownWindow: maxTokens > 0,
    contextOutput,
    maxTokens,
    contextUsed,
    hasContextMetric,
    contextPct,
    contextRemaining,
    userMsgCount,
  };
}
