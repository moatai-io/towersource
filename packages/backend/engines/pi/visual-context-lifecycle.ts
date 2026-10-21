// Canonical history stays intact; observed PDF pixels use a bounded provider-only window.
import { configuredPiRequestBodyLimit } from './provider-request-budget.js';
import { configuredPdfRecentPages, configuredPiImageLimit, configuredPiImageByteLimit } from './image-request-policy.js';
import { PdfObservationState, pdfReference } from './pdf-observation-state.js';
import { sanitizeEmbeddedBinaryText } from '../../services/content-safety/embedded-binary.js';

// Provider-only tool text limits. Keep a useful fresh answer and a small recent
// history, while leaving canonical Agent messages and the session file intact.
export const PI_FRESH_TOOL_TEXT_BYTES = 64 * 1024;
export const PI_HISTORICAL_TOOL_TEXT_BYTES = 2 * 1024;
export const PI_HISTORICAL_TOOL_TEXT_TOTAL_BYTES = 96 * 1024;

function jsonStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8');
}

/** Return the longest prefix/suffix whose JSON string representation fits. */
function clippedJsonText(text: string, budget: number, suffix: boolean): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const candidate = suffix ? text.slice(-length) : text.slice(0, length);
    if (jsonStringBytes(candidate) - 2 <= budget) low = length;
    else high = length - 1;
  }
  const candidate = suffix ? text.slice(-low) : text.slice(0, low);
  // Do not split a surrogate pair at the cut point.
  if (suffix && /^[\uDC00-\uDFFF]/u.test(candidate)) return candidate.slice(1);
  if (!suffix && /[\uD800-\uDBFF]$/u.test(candidate)) return candidate.slice(0, -1);
  return candidate;
}

function boundedToolText(text: string, maxBytes: number, label: string): string {
  if (maxBytes <= 2) return '';
  const safe = sanitizeEmbeddedBinaryText(text);
  const encodedBytes = jsonStringBytes(safe);
  if (encodedBytes <= maxBytes) return safe;
  const marker = `\n[${label}: ${encodedBytes} JSON bytes; original tool result remains in the session. Reopen the source with a narrower query/range if needed.]\n`;
  const markerBytes = jsonStringBytes(marker);
  if (markerBytes >= maxBytes) return '';
  const available = maxBytes - markerBytes;
  const head = Math.ceil(available * 0.75);
  return clippedJsonText(safe, head, false) + marker + clippedJsonText(safe, available - head, true);
}

/** Retire only explicitly observed, versioned PDF pixels. Unknown/user/fresh
 * images stay unchanged. Pins last until released or the next user request. */
function projectHistoricalPdfImages(source: any[], state: PdfObservationState): any[] {
  let lastUser = -1;
  source.forEach((message, index) => { if (message.role === 'user') lastUser = index; });
  const released = new Set<string>();
  for (const message of source) {
    if (message.role !== 'assistant' || ['error', 'aborted'].includes(message.stopReason)) continue;
    for (const part of message.content || []) if (part.type === 'text') {
      for (const match of (part.text || '').matchAll(/\[PDF unpin batch=([a-f0-9]{24})\]/g)) released.add(match[1]);
    }
  }
  const refs = source.map(pdfReference);
  const keep = new Set<string>(); const recent = new Set<string>();
  for (let i = source.length - 1; i >= 0; i--) {
    const ref = refs[i]; if (!ref) continue;
    for (let j = ref.pages.length - 1; j >= 0; j--) {
      const key = JSON.stringify([ref.source, ref.sourceVersion, ref.pages[j]]);
      if (recent.has(key)) continue;
      if (recent.size < configuredPdfRecentPages()) { recent.add(key); keep.add(`${i}:${j}`); }
    }
  }
  let totalImages = 0; let totalBytes = 0;
  for (const message of source) for (const part of message.content || []) {
    if (part.type === 'image' && typeof part.data === 'string') { totalImages++; totalBytes += Buffer.byteLength(part.data); }
  }
  const projected = source.map((message, index) => {
    const ref = refs[index];
    if (!ref || !state.has(ref) || (ref.pinned && index > lastUser && !released.has(ref.batchId!))) return message;
    let ordinal = 0; const removed: number[] = [];
    const content = message.content.filter((part: any) => {
      if (part.type !== 'image') return true;
      const pageIndex = ordinal++;
      const byteLimit = Math.min(configuredPiRequestBodyLimit() * 0.4, configuredPiImageByteLimit() * 4 / 3);
      const pressure = totalImages > configuredPiImageLimit() || totalBytes > byteLimit;
      if (keep.has(`${index}:${pageIndex}`) && !pressure) return true;
      removed.push(ref.pages[pageIndex]); totalImages--; totalBytes -= Buffer.byteLength(part.data || ''); return false;
    });
    if (!removed.length) return message;
    return { ...message, content: [...content, { type: 'text', text:
      `[Previously observed PDF pixels omitted from this provider request: ${JSON.stringify({ source: ref.source, pages: removed, dpi: ref.dpi, batchId: ref.batchId })}. `
      + 'Original history/cache unchanged; reopen with pdf_view for comparisons or details not in notes. Requery repeats current authorization.]' }] };
  });
  const ledger = state.ledger();
  if (!ledger) return projected;
  for (let i = projected.length - 1; i >= 0; i--) {
    if (projected[i].role === 'user') {
      projected[i] = { ...projected[i], content: [...(Array.isArray(projected[i].content) ? projected[i].content
        : [{ type: 'text', text: String(projected[i].content || '') }]), { type: 'text', text: ledger }] };
      break;
    }
  }
  return projected;
}

/** Provider-only text/image projection; canonical source is never mutated. */
export function createPiVisualContextTransform(state = new PdfObservationState()) {
  return async (messages: any[]): Promise<any[]> => {
    const source = Array.isArray(messages) ? messages : [];
    // Link canonical notes before provider-only text clipping can truncate them.
    state.observe(source);
    let lastAssistantIndex = -1;
    for (let index = source.length - 1; index >= 0; index--) {
      if (source[index]?.role === 'assistant') { lastAssistantIndex = index; break; }
    }
    // Text results from all unanswered parallel calls share one fresh budget.
    // Historical results receive a separate, newest-first global budget so
    // thousands of prior tool calls cannot each claim a full excerpt.
    let freshTextRemaining = PI_FRESH_TOOL_TEXT_BYTES;
    let historicalTextRemaining = PI_HISTORICAL_TOOL_TEXT_TOTAL_BYTES;
    const textByIndex = new Map<number, any[]>();
    for (let index = source.length - 1; index >= 0; index--) {
      const message = source[index];
      if (message?.role !== 'toolResult' || !Array.isArray(message.content)) continue;
      const fresh = index > lastAssistantIndex;
      const content = message.content.map((part: any) => {
        if (part?.type !== 'text' || typeof part.text !== 'string') return part;
        const remaining = fresh ? freshTextRemaining : historicalTextRemaining;
        const limit = fresh ? Math.min(remaining, PI_FRESH_TOOL_TEXT_BYTES) : Math.min(remaining, PI_HISTORICAL_TOOL_TEXT_BYTES);
        const text = boundedToolText(part.text, limit, fresh ? 'fresh tool text shortened for provider request' : 'older tool text shortened for provider request');
        const used = Math.min(remaining, jsonStringBytes(text));
        if (fresh) freshTextRemaining -= used;
        else historicalTextRemaining -= used;
        return text === part.text ? part : { ...part, text };
      });
      textByIndex.set(index, content);
    }
    return projectHistoricalPdfImages(source.map((message: any, index: number) => {
      const content = textByIndex.get(index);
      return content ? { ...message, content } : message;
    }), state);
  };
}

/** Preserve SDK context/forced-prompt hooks while applying Tower tool-text limits. */
export function installPiVisualContextTransform(agent: {
  transformContext?: (messages: any[], signal?: AbortSignal) => Promise<any[]>;
}, state = new PdfObservationState()): void {
  const sdkTransformContext = agent.transformContext;
  const visualTransformContext = createPiVisualContextTransform(state);
  agent.transformContext = async (messages, signal) => visualTransformContext(
    sdkTransformContext ? await sdkTransformContext.call(agent, messages, signal) : messages,
  );
}
