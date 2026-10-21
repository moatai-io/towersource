import { normalizeContextMeasurement } from './context-measurement';
import type { ChatMessage } from '../stores/chat-store';
import type { SessionMeta } from '../stores/session-store';
import type { ModelOption } from '../stores/model-store';

export function modelIdFromSessionForLookup(session?: Pick<SessionMeta, 'engine' | 'modelUsed'> | null): string | undefined {
  if (!session?.modelUsed) return undefined;
  if (session.engine === 'pi' && !session.modelUsed.startsWith('pi:')) return `pi:${session.modelUsed}`;
  if (session.engine === 'local' && !session.modelUsed.startsWith('local:')) return `local:${session.modelUsed}`;
  return session.modelUsed;
}

export function contextWindowForSession(
  session: Pick<SessionMeta, 'engine' | 'modelUsed'> | null | undefined,
  models: ReadonlyArray<ModelOption>,
): number {
  const modelId = modelIdFromSessionForLookup(session);
  if (!modelId) return 0;
  return models.find((m) => m.id === modelId)?.contextWindow || 0;
}

export function contextInputFromUsageOrRow(row: {
  input_tokens?: number | null;
  inputTokens?: number | null;
  contextEstimatedTokens?: number | null;
  contextCompacted?: boolean;
  metadata?: any;
}): number {
  const usage = row.metadata?.usage || {};
  return normalizeContextMeasurement({
    requestId: 'restored', measuredAt: 0, actual: usage.context_input_tokens,
    estimated: usage.context_estimated_tokens || row.contextEstimatedTokens,
    compacted: usage.context_compacted === true || row.contextCompacted === true,
    // Older imported rows with no usage metadata do not establish provider attribution.
    uncached: (Number(usage.cache_read_tokens) > 0 || Number(usage.cache_creation_tokens) > 0) ? (row.input_tokens || row.inputTokens) : undefined,
    cacheRead: usage.cache_read_tokens, cacheWrite: usage.cache_creation_tokens,
  })?.inputTokens || 0;
}

export function contextWindowFromUsageOrSession(row: {
  contextWindowSize?: number | null;
  metadata?: any;
}, fallbackWindow: number): number {
  return Number(row.metadata?.usage?.context_window_size || row.contextWindowSize || fallbackWindow || 0);
}

export function deriveContextMetricFromMessages(params: {
  messages: ReadonlyArray<ChatMessage>;
  session?: Pick<SessionMeta, 'engine' | 'modelUsed'> | null;
  models?: ReadonlyArray<ModelOption>;
}): { contextInput: number; contextOutput: number; contextWindow: number; contextCompacted?: boolean; contextSnapshot?: unknown } | null {
  const fallbackWindow = contextWindowForSession(params.session, params.models || []);
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const msg = params.messages[i];
    if (msg.role !== 'assistant') continue;
    const contextInput = contextInputFromUsageOrRow(msg);
    const contextWindow = contextWindowFromUsageOrSession(msg, fallbackWindow);
    if (contextInput > 0 && contextWindow > 0) {
      return {
        contextInput,
        contextSnapshot: msg.metadata?.usage?.context_snapshot,
        contextCompacted: msg.metadata?.usage?.context_compacted === true || msg.contextCompacted === true,
        contextOutput: msg.outputTokens || 0,
        contextWindow,
      };
    }
  }
  return null;
}
