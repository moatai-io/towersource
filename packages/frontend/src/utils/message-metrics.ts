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
  metadata?: any;
}): number {
  const usage = row.metadata?.usage || {};
  const estimated = Number(usage.context_estimated_tokens || row.contextEstimatedTokens || 0);
  const explicit = Number(usage.context_input_tokens || 0);
  if (estimated > 0 && explicit > 0) return Math.min(estimated, explicit);
  if (estimated > 0) return estimated;
  if (explicit > 0) return explicit;

  // OpenAI/LiteLLM Responses commonly reports cached prompt as cache_read_tokens
  // plus only the uncached suffix in input_tokens. For context usage, both are
  // live prompt tokens and must be added. Without this, Smartest rows whose
  // context_window_size is omitted look tiny, so UI scans backward and may pick
  // an old Azure 400K metric row from before a model switch.
  const cacheRead = Number(usage.cache_read_tokens || 0);
  const cacheCreation = Number(usage.cache_creation_tokens || 0);
  const input = Number(row.input_tokens ?? row.inputTokens ?? 0);
  if (cacheRead > 0 || cacheCreation > 0) return cacheRead + cacheCreation + input;

  // A bare input_tokens value is ambiguous on legacy/imported Pi rows: it can
  // be only the uncached suffix or one tool iteration rather than the whole
  // prompt. Showing it as full session context produced misleading values such
  // as 432 / 353.4k. Wait for an explicit snapshot, estimate, or cache-aware
  // row instead of presenting a precise-looking undercount.
  return 0;
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
}): { contextInput: number; contextOutput: number; contextWindow: number } | null {
  const fallbackWindow = contextWindowForSession(params.session, params.models || []);
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const msg = params.messages[i];
    if (msg.role !== 'assistant') continue;
    const contextInput = contextInputFromUsageOrRow(msg);
    const contextWindow = contextWindowFromUsageOrSession(msg, fallbackWindow);
    if (contextInput > 0 && contextWindow > 0) {
      return {
        contextInput,
        contextOutput: msg.outputTokens || 0,
        contextWindow,
      };
    }
  }
  return null;
}
