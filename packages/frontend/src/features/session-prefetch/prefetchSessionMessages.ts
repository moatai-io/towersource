import { useChatStore, type ChatMessage } from '../../stores/chat-store';
import { useModelStore } from '../../stores/model-store';
import { useSessionStore, type SessionMeta } from '../../stores/session-store';
import { filterPendingSteerMessages } from '../../utils/pending-steer-filter';
import { cacheSessionMessages, sessionMsgCache } from '../../utils/session-message-cache';
import { deriveContextMetricFromMessages } from '../../utils/message-metrics';

const API_BASE = '/api';
const MAX_CONCURRENT_PREFETCH = 2;
const prefetchingSet = new Set<string>();
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

type ContextCostPatch = Pick<import('../../stores/chat-store').CostInfo, 'contextSnapshot' | 'contextInputTokens' | 'contextOutputTokens' | 'contextWindowSize' | 'contextEstimatedTokens'>;

function deriveContextCostFromMessages(messages: ChatMessage[], session?: SessionMeta | null): ContextCostPatch {
  const modelState = useModelStore.getState();
  const metric = deriveContextMetricFromMessages({
    messages,
    session,
    models: [...modelState.availableModels, ...modelState.piModels, ...modelState.localModels],
  });
  if (!metric) return { contextSnapshot: undefined, contextInputTokens: 0, contextOutputTokens: 0, contextWindowSize: 0, contextEstimatedTokens: 0 };
  return {
    contextSnapshot: metric.contextSnapshot,
    contextInputTokens: metric.contextInput,
    contextOutputTokens: metric.contextOutput,
    contextWindowSize: metric.contextWindow,
    contextEstimatedTokens: metric.contextInput,
  };
}

function parseStoredMessageContent(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string') return [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [{ type: 'text', text: parsed }];
    return [];
  } catch {
    return [{ type: 'text', text: content }];
  }
}

function filterLivePendingSteerRows(sessionId: string, messages: ChatMessage[]): ChatMessage[] {
  return filterPendingSteerMessages(
    messages,
    useChatStore.getState().pendingInjections[sessionId],
    useSessionStore.getState().streamingSessions.has(sessionId),
  );
}

/** Warm a hovered session without importing the App shell back into session rows. */
export function prefetchSessionMessages(sessionId: string) {
  if (sessionMsgCache.has(sessionId) || prefetchingSet.has(sessionId)) return;
  if (prefetchingSet.size >= MAX_CONCURRENT_PREFETCH) return;

  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    if (sessionMsgCache.has(sessionId) || prefetchingSet.has(sessionId)) return;
    if (prefetchingSet.size >= MAX_CONCURRENT_PREFETCH) return;

    prefetchingSet.add(sessionId);
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    Promise.all([
      fetch(`${API_BASE}/sessions/${sessionId}`, { headers }).then(response => response.ok ? response.json() : null).catch(() => null),
      fetch(`${API_BASE}/sessions/${sessionId}/messages?limit=500`, { headers }).then(response => response.ok ? response.json() : null).catch(() => null),
    ])
      .then(([sessionMeta, data]) => {
        if (!data) return;
        const stored = data.messages ?? data;
        if (!stored?.length) return;
        const messages = filterLivePendingSteerRows(sessionId, stored.map((message: any) => ({
          id: message.id,
          shortId: message.short_id || undefined,
          role: message.role,
          content: parseStoredMessageContent(message.content),
          timestamp: new Date(message.created_at).getTime(),
          updatedAt: message.updated_at ? new Date(message.updated_at).getTime() : undefined,
          completedAt: message.completed_at ? new Date(message.completed_at).getTime() : undefined,
          parentToolUseId: message.parent_tool_use_id,
          durationMs: message.duration_ms || undefined,
          inputTokens: message.input_tokens || undefined,
          outputTokens: message.output_tokens || undefined,
          reasoningTokens: message.metadata?.usage?.reasoning_tokens || undefined,
          contextWindowSize: message.metadata?.usage?.context_window_size || undefined,
          stopReason: message.stop_reason || undefined,
          metadata: message.metadata ?? null,
        })));
        cacheSessionMessages(sessionId, messages);
        if (useSessionStore.getState().activeSessionId !== sessionId) return;
        const store = useChatStore.getState();
        store.setCost({
          ...store.cost,
          ...deriveContextCostFromMessages(messages, sessionMeta || useSessionStore.getState().sessions.find(session => session.id === sessionId)),
        });
      })
      .catch(() => {})
      .finally(() => prefetchingSet.delete(sessionId));
  }, 150);
}
