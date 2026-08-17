// Keeps vision payloads available for the immediate provider turn without
// replaying old base64 images on every later request.

export const PI_VISUAL_CONTEXT_RECENT_TOOL_RESULTS = 1;
export const PI_VISUAL_CONTEXT_BASE_WINDOW = 353_400;
export const PI_VISUAL_CONTEXT_BASE_IMAGE_BYTES = 512 * 1024;
export const PI_VISUAL_CONTEXT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export interface PiVisualContextBudget {
  contextWindow?: number;
  maxFreshImageBytes?: number;
}

function estimatedBase64Bytes(data: string): number {
  const normalized = data.replace(/\s/g, '');
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

/**
 * Reserve most of the provider window for instructions, tool schemas, text, and
 * output. The base 353k model gets 512 KiB of fresh pixels; larger-context
 * models scale proportionally but never exceed 2 MiB in one request.
 */
export function piFreshVisualByteBudget(options: PiVisualContextBudget = {}): number {
  if (Number.isFinite(options.maxFreshImageBytes) && Number(options.maxFreshImageBytes) >= 0) {
    return Math.floor(Number(options.maxFreshImageBytes));
  }
  const contextWindow = Number.isFinite(options.contextWindow) && Number(options.contextWindow) > 0
    ? Number(options.contextWindow)
    : PI_VISUAL_CONTEXT_BASE_WINDOW;
  return Math.min(
    PI_VISUAL_CONTEXT_MAX_IMAGE_BYTES,
    Math.max(0, Math.floor(PI_VISUAL_CONTEXT_BASE_IMAGE_BYTES * contextWindow / PI_VISUAL_CONTEXT_BASE_WINDOW)),
  );
}

function visualPlaceholder(part: any, reason = 'previous visual payload omitted'): any {
  return {
    type: 'text',
    text: `[${reason}; reopen the source with the relevant view tool at a smaller page range or resolution if pixels are needed again: ${part?.mimeType || 'image'}]`,
  };
}

/**
 * Returns a provider-only copy. Source Agent messages and persisted JSONL are
 * not mutated. Images in the newest N tool results remain available so the
 * model can inspect the tool it just called; older tool-result images become
 * small references before request serialization.
 */
export function sanitizePiVisualContextForProvider(messages: any[], keepRecentToolResults = PI_VISUAL_CONTEXT_RECENT_TOOL_RESULTS): any[] {
  const source = Array.isArray(messages) ? messages : [];
  const visualToolResultIndexes = source
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message?.role === 'toolResult'
      && Array.isArray(message.content)
      && message.content.some((part: any) => part?.type === 'image'))
    .map(({ index }) => index);
  const keepCount = Math.max(0, keepRecentToolResults);
  const keep = new Set(keepCount > 0 ? visualToolResultIndexes.slice(-keepCount) : []);

  return source.map((message, index) => {
    if (!Array.isArray(message?.content)) return message;
    let changed = false;
    const content = message.content.map((part: any) => {
      if (part?.type !== 'image') return part;
      if (message?.role === 'toolResult' && keep.has(index)) return part;
      changed = true;
      return visualPlaceholder(part);
    });
    return changed ? { ...message, content } : message;
  });
}

/** Session-scoped transform: each newly observed visual tool result gets one
 * provider opportunity, subject to a context-aware aggregate byte budget.
 * Later or over-budget pixels retain only a reference. */
export function createPiVisualContextTransform(options: PiVisualContextBudget = {}) {
  const consumedToolCalls = new Set<string>();
  const maxFreshImageBytes = piFreshVisualByteBudget(options);
  return async (messages: any[]): Promise<any[]> => {
    const source = Array.isArray(messages) ? messages : [];
    const latestFresh = [...source].reverse().find((message: any) => message?.role === 'toolResult'
      && typeof message?.toolCallId === 'string'
      && !consumedToolCalls.has(message.toolCallId)
      && Array.isArray(message.content)
      && message.content.some((part: any) => part?.type === 'image'));
    const keepIndex = latestFresh ? source.indexOf(latestFresh) : -1;
    let retainedFreshImageBytes = 0;
    const sanitized = source.map((message: any, index: number) => {
      if (!Array.isArray(message?.content)) return message;
      let changed = false;
      const content = message.content.map((part: any) => {
        if (part?.type !== 'image') return part;
        if (index !== keepIndex) {
          changed = true;
          return visualPlaceholder(part);
        }
        const bytes = typeof part.data === 'string' ? estimatedBase64Bytes(part.data) : 0;
        if (bytes > 0 && retainedFreshImageBytes + bytes <= maxFreshImageBytes) {
          retainedFreshImageBytes += bytes;
          return part;
        }
        changed = true;
        return visualPlaceholder(part, `fresh visual payload omitted by provider context budget (${bytes} bytes; remaining ${Math.max(0, maxFreshImageBytes - retainedFreshImageBytes)} bytes)`);
      });
      return changed ? { ...message, content } : message;
    });
    if (latestFresh?.toolCallId) consumedToolCalls.add(latestFresh.toolCallId);
    return sanitized;
  };
}
