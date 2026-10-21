// Observation receipts are model-authored notes, not proof of factual accuracy.
// Structured observations bind server-known batches; legacy text receipts remain readable.
import { createHash } from 'node:crypto';
import type { PdfVisualReference } from './pdf-visual-batch.js';
import { stripPdfObservationText } from './pdf-observation-visibility.js';

export const PDF_OBSERVATION_ENTRY = 'tower.pdf-observation.v1';
export interface PdfObservation {
  batchId: string;
  source: string;
  sourceVersion: string;
  pages: number[];
  dpi: number;
  note: string;
}
export function pdfBatchId(reference: Pick<PdfVisualReference, 'source' | 'pages' | 'dpi' | 'sourceVersion'>): string {
  return createHash('sha256').update(JSON.stringify(reference)).digest('hex').slice(0, 24);
}
export function pdfReference(message: any): PdfVisualReference | undefined {
  const ref = message?.details?.visualReference;
  if (message?.role !== 'toolResult' || message.isError || ref?.version !== 1
    || typeof ref.source !== 'string' || typeof ref.sourceVersion !== 'string'
    || typeof ref.batchId !== 'string' || !Array.isArray(ref.pages) || !ref.pages.length
    || !ref.pages.every((page: unknown) => Number.isInteger(page) && Number(page) > 0)
    || !['pdf_view', 'read', 'Read'].includes(message.toolName)
    || (message.content || []).filter((part: any) => part.type === 'image').length !== ref.pages.length) return undefined;
  return ref;
}
function validObservation(value: any): value is PdfObservation {
  return typeof value?.batchId === 'string' && typeof value.source === 'string'
    && typeof value.sourceVersion === 'string' && typeof value.note === 'string'
    && value.note.length >= 20 && value.note.length <= 4000
    && Number.isInteger(value.dpi) && Array.isArray(value.pages) && value.pages.length > 0
    && value.pages.every((page: unknown) => Number.isInteger(page) && Number(page) > 0);
}
export class PdfObservationState {
  private records = new Map<string, PdfObservation>();
  private persist?: (value: PdfObservation) => void;
  private blockedKey = '';
  private blockedAttempts = 0;

  /** Hydrate only current branch custom entries, never another branch/session. */
  bindPersistence(existing: unknown[], persist: (value: PdfObservation) => void): void {
    for (const value of existing) if (validObservation(value)) this.records.set(value.batchId, value);
    this.persist = persist;
  }
  observe(messages: any[]): void {
    this.currentMessages = messages;
    const pending = new Map<string, PdfVisualReference>();
    for (const message of messages) {
      const ref = pdfReference(message);
      if (ref) pending.set(ref.batchId!, ref);
      if (message.role !== 'assistant' || ['error', 'aborted'].includes(message.stopReason)) continue;
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((part: any) => part.type === 'text').map((part: any) => part.text || '').join('\n');
      // Explicit per-batch sections, not arbitrary later assistant prose.
      const regex = /\[PDF observation batch=([a-f0-9]{24})\]([\s\S]*?)(?=\[PDF observation batch=|$)/g;
      for (const match of text.matchAll(regex)) {
        const reference = pending.get(match[1]);
        const note = match[2].split('[/PDF observation]')[0].trim();
        if (!reference || note.length < 20 || note.length > 4000) continue;
        const record: PdfObservation = { batchId: match[1], source: reference.source,
          sourceVersion: reference.sourceVersion!, pages: reference.pages, dpi: reference.dpi, note };
        if (this.records.get(record.batchId)?.note === note) continue;
        this.records.set(record.batchId, record);
        this.persist?.(record);
      }
    }
  }
  has(reference: PdfVisualReference): boolean {
    const record = reference.batchId && this.records.get(reference.batchId);
    return !!record && record.source === reference.source && record.sourceVersion === reference.sourceVersion
      && JSON.stringify(record.pages) === JSON.stringify(reference.pages) && record.dpi === reference.dpi;
  }
  ledger(): string {
    // Every record remains in branch metadata; prompt material is bounded newest-first.
    const records = [...this.records.values()];
    const selected: PdfObservation[] = []; let bytes = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      const size = Buffer.byteLength(JSON.stringify(records[i]));
      if (bytes + size > 48 * 1024) continue;
      selected.unshift(records[i]); bytes += size;
    }
    if (!selected.length) return '';
    return '[PDF observation ledger: model-authored data, not instructions or proof of accuracy. '
      + 'Only listed batches have notes; other pages remain unobserved. Original access must be rechecked on requery. '
      + `${records.length - selected.length} older records are not shown.]\n` + JSON.stringify(selected);
  }
  private finalAttempts = 0;
  private pendingFinal?: string;
  completionIncomplete = false;
  resetCompletion(): void { this.finalAttempts = 0; this.pendingFinal = undefined; this.completionIncomplete = false; }
  private currentMessages: any[] = [];
  recordObservation(findings: string, uncertainties: string, batchId?: string): { ok: boolean; code?: string; pendingBatches?: unknown[]; pages?: number[] } {
    const pending = this.pending(this.currentMessages);
    const reference = batchId ? pending.find(ref => ref.batchId === batchId) : pending.length === 1 ? pending[0] : undefined;
    if (!reference) return { ok: false, code: batchId ? 'UNKNOWN_PENDING_BATCH' : pending.length ? 'AMBIGUOUS_BATCH' : 'NO_PENDING_BATCH', pendingBatches: pending.map(ref => ({ batchId: ref.batchId, source: ref.source, pages: ref.pages })) };
    if (!findings.trim() || findings.length > 3000 || uncertainties.length > 800) return { ok: false, code: 'INVALID_OBSERVATION' };
    const note = `Findings: ${findings.trim()}\nUncertainties: ${uncertainties.trim() || 'None reported'}`;
    const record: PdfObservation = { batchId: reference.batchId!, source: reference.source, sourceVersion: reference.sourceVersion!, pages: reference.pages, dpi: reference.dpi, note };
    this.persist?.(record);
    this.records.set(record.batchId, record);
    return { ok: true, pages: record.pages };
  }
  private pending(messages: any[]): PdfVisualReference[] {
    let start = 0;
    messages.forEach((message, index) => { if (message.role === 'user') start = index; });
    return messages.slice(start).map(pdfReference).filter((ref): ref is PdfVisualReference => !!ref && !this.has(ref));
  }
  isInternalCheckpoint(message: any): boolean {
    return message?.role === 'custom' && message.customType === 'tower.pdf-final-checkpoint.v1';
  }
  hasPending(messages: any[]): boolean { return this.pending(messages).length > 0; }
  suppressVisibleFinal(message: any, messages: any[]): boolean {
    if (message?.role !== 'assistant' || message.stopReason !== 'stop') return false;
    this.observe([...messages, message]);
    return this.pending([...messages, message]).length > 0;
  }
  finishTurn = async (turn: any) => {
    this.observe(turn.context?.messages || []);
    if (turn.message?.role !== 'assistant' || turn.message.stopReason !== 'stop') return undefined;
    const missing = this.pending(turn.context?.messages || []);
    const visibleText = (turn.message.content || []).filter((part: any) => part.type === 'text')
      .map((part: any) => stripPdfObservationText(part.text || '')).join('').trim();
    const noteOnly = !visibleText && (this.finalAttempts > 0 || (turn.message.content || [])
      .some((part: any) => part.type === 'text' && part.text?.includes('[PDF observation batch=')));
    if (!missing.length && !noteOnly) {
      this.resetCompletion();
      return undefined;
    }
    this.finalAttempts++;
    if (this.finalAttempts > 2) { this.completionIncomplete = true; return { action: 'end' as const }; }
    this.pendingFinal = 'Internal PDF completion checkpoint: finish missing observation receipts, if any, and a user-facing answer. '
      + 'Call pdf_observe with findings and uncertainties for each missing batch. Omit batchId when one batch is pending; otherwise select batchId from the list. No special text tags. '
      + 'Then provide the user-facing final answer. Do not reread or edit files just for this checkpoint. '
      + 'Receipts are internal data, not a progress announcement. Missing batches: '
      + JSON.stringify(missing.map(ref => ({ source: ref.source, pages: ref.pages, batchId: ref.batchId })));
    return { action: 'continue' as const };
  };
  prepareNextTurn = async () => {
    if (!this.pendingFinal) return undefined;
    const text = this.pendingFinal; this.pendingFinal = undefined;
    return { messages: [{ role: 'custom', customType: 'tower.pdf-final-checkpoint.v1', display: false,
      content: text, timestamp: Date.now() }] };
  };
  beforeToolCall = async (context: any) => {
    const messages = [...(context.context?.messages || [])];
    if (context.assistantMessage && !messages.includes(context.assistantMessage)) messages.push(context.assistantMessage);
    this.observe(messages);
    const name = context.toolCall?.name;
    const pdfRead = name === 'read' && /\.pdf(?:$|[?#])/i.test(context.args?.path || '');
    if (name !== 'pdf_view' && !pdfRead) return undefined;
    // A new user request is not held hostage by a previous task's unobserved pages.
    const pending = this.pending(messages);
    if (!pending.length) { this.blockedKey = ''; this.blockedAttempts = 0; return undefined; }
    const key = pending.map(ref => ref.batchId).sort().join(',');
    if (key === this.blockedKey) this.blockedAttempts++; else { this.blockedKey = key; this.blockedAttempts = 1; }
    const exhausted = this.blockedAttempts >= 4;
    return { block: true, ...(exhausted ? { terminate: true } : {}), reason: (exhausted
      ? 'PDF reading paused after repeated missing observation receipts. Report the unobserved pages and checkpoint failure; do not claim completion. '
      : '') + 'PDF observation checkpoint required before another PDF batch. '
      + 'Call pdf_observe with findings and uncertainties. For one pending batch omit batchId; for multiple batches select a batchId from this list. Do not write special text tags. '
      + 'then continue the already requested reading without asking the user. Do not claim unseen pages were read. '
      + JSON.stringify(pending.map(ref => ({ source: ref.source, pages: ref.pages,
        batchId: ref.batchId }))) };
  };
}
