import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfObservationState, pdfBatchId } from './pdf-observation-state.js';
import { createPiVisualContextTransform } from './visual-context-lifecycle.js';
import { configuredPdfRecentPages, configuredPiImageLimit } from './image-request-policy.js';

function pdf(page: number, extra: Record<string, unknown> = {}) {
  const ref = { version: 1 as const, source: 'session://attachments/test', sourceVersion: 'v1', pages: [page], dpi: 144, ...extra };
  const reference = { ...ref, batchId: pdfBatchId(ref) };
  return { role: 'toolResult', toolName: 'pdf_view', toolCallId: `p${page}`, isError: false,
    details: { visualReference: reference }, content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] };
}
function note(result: ReturnType<typeof pdf>, stopReason = 'toolUse') {
  return { role: 'assistant', stopReason, content: [{ type: 'text', text:
    `[PDF observation batch=${result.details.visualReference.batchId}] Page ${result.details.visualReference.pages[0]} findings: alpha value 42; small text requires requery.` }] };
}
const user = { role: 'user', content: [{ type: 'text', text: 'Read all pages' }] };
const images = (messages: any[]) => messages.flatMap(m => m.content || []).filter(p => p.type === 'image');
afterEach(() => vi.unstubAllEnvs());

describe('PDF explicit observation receipts and recent pixel window', () => {
  it('uses positive validated defaults: 8 pages and 50 images', () => {
    expect(configuredPdfRecentPages()).toBe(8); expect(configuredPiImageLimit()).toBe(50);
    vi.stubEnv('PI_PDF_RECENT_IMAGE_PAGES', 'NaN'); vi.stubEnv('PI_RESPONSES_MAX_INLINE_FILE_IMAGES', '-1');
    expect(configuredPdfRecentPages()).toBe(8); expect(configuredPiImageLimit()).toBe(50);
  });
  it.each([29, 40, 100])('retains only 8 observed pages after reading %i pages even under byte thresholds', async count => {
    const state = new PdfObservationState(); const messages: any[] = [user];
    for (let p = 1; p <= count; p++) { const result = pdf(p); messages.push(result, note(result)); }
    const before = JSON.stringify(messages);
    const prepared = await createPiVisualContextTransform(state)(messages);
    expect(images(prepared)).toHaveLength(8);
    const retained = prepared.filter(m => m.role === 'toolResult' && images([m]).length).map(m => m.details.visualReference.pages[0]);
    expect(retained).toEqual(Array.from({ length: 8 }, (_, i) => count - 7 + i));
    expect(JSON.stringify(prepared[0])).toContain('PDF observation ledger');
    expect(JSON.stringify(messages)).toBe(before);
  });
  it('requires matching later explicit receipts, not arbitrary text or error output', async () => {
    const messages: any[] = [user];
    for (let p = 1; p <= 30; p++) messages.push(pdf(p));
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I read everything' }] }, note(pdf(1), 'error'));
    const prepared = await createPiVisualContextTransform()(messages);
    expect(images(prepared)).toHaveLength(30);
    const state = new PdfObservationState();
    const blocked = await state.beforeToolCall({ toolCall: { name: 'pdf_view' }, args: { path: 'file.pdf' }, context: { messages } });
    expect(blocked?.block).toBe(true); expect(blocked?.reason).toContain('checkpoint');
  });
  it('rejects receipts before the pixels, changed version and non-PDF/unknown result', () => {
    const result = pdf(1); const state = new PdfObservationState();
    state.observe([note(result), result]); expect(state.has(result.details.visualReference)).toBe(false);
    state.observe([result, note(result)]); expect(state.has(result.details.visualReference)).toBe(true);
    expect(state.has({ ...result.details.visualReference, sourceVersion: 'v2' })).toBe(false);
    const unknown = { ...result, toolName: 'screenshot' };
    const other = new PdfObservationState(); other.observe([unknown, note(result)]);
    expect(other.has(result.details.visualReference)).toBe(false);
  });
  it('allows the next batch after an explicit receipt without a new public tool', async () => {
    const result = pdf(1); const state = new PdfObservationState();
    expect(await state.beforeToolCall({ toolCall: { name: 'pdf_view' }, args: {}, context: { messages: [user, result] }, assistantMessage: note(result) })).toBeUndefined();
    expect(await state.beforeToolCall({ toolCall: { name: 'bash' }, context: { messages: [pdf(2)] } })).toBeUndefined();
  });
  it('keeps fresh, pinned comparison and user pixels; releases pins explicitly or at next user turn', async () => {
    const pinned = pdf(1, { pinned: true }); const messages: any[] = [user, pinned, note(pinned)];
    for (let p = 2; p <= 12; p++) { const result = pdf(p); messages.push(result, note(result)); }
    const fresh = pdf(13); messages.push(fresh);
    const transform = createPiVisualContextTransform();
    const prepared = await transform(messages);
    expect(images([prepared[1]])).toHaveLength(1); expect(images([prepared.at(-1)])).toHaveLength(1);
    expect(images(prepared)).toHaveLength(9); // pinned + 7 observed + 1 fresh
    const released = await transform([...messages, { role: 'assistant', content: [{ type: 'text', text: `[PDF unpin batch=${pinned.details.visualReference.batchId}]` }] }]);
    expect(images([released[1]])).toHaveLength(0);
    const next = await transform([...messages, { role: 'user', content: [{ type: 'image', data: 'USER' }] }]);
    expect(images([next[1]])).toHaveLength(0); expect(images([next.at(-1)])).toHaveLength(1);
  });
  it('preserves receipts across native compaction and branch/session rehydration', async () => {
    const result = pdf(1); const saved: any[] = []; const state = new PdfObservationState();
    state.bindPersistence([], record => saved.push(record)); state.observe([result, note(result)]); state.observe([result, note(result)]);
    expect(saved).toHaveLength(1);
    const hydrated = new PdfObservationState(); hydrated.bindPersistence(saved, () => {});
    expect(hydrated.has(result.details.visualReference)).toBe(true);
    const projected = await createPiVisualContextTransform(hydrated)([user]);
    expect(JSON.stringify(projected)).toContain('alpha value 42');
    const unrelated = new PdfObservationState(); unrelated.bindPersistence([], () => {});
    expect(unrelated.has(result.details.visualReference)).toBe(false);
  });
  it('keeps legacy references and returned pixels without receipts even under pressure', async () => {
    vi.stubEnv('PI_PROVIDER_MAX_REQUEST_BODY_BYTES', '1000');
    const legacy = pdf(1); delete (legacy.details.visualReference as any).sourceVersion;
    const result = pdf(2); const retry = { ...pdf(3), isError: true };
    const prepared = await createPiVisualContextTransform()([user, legacy, result, retry]);
    expect(images(prepared)).toHaveLength(3);
  });
  it('stops repeated missing-receipt loops with a bounded hook termination hint', async () => {
    const state = new PdfObservationState(); const context = { toolCall: { name: 'pdf_view' }, context: { messages: [user, pdf(1)] } };
    for (let i = 0; i < 3; i++) expect((await state.beforeToolCall(context))?.terminate).toBeUndefined();
    expect((await state.beforeToolCall(context))?.terminate).toBe(true);
    expect(await state.beforeToolCall({ ...context, context: { messages: [user, pdf(1), user] } })).toBeUndefined();
  });
  it('reopened same pages need a fresh observation receipt', () => {
    const state = new PdfObservationState(); const first = pdf(1); state.observe([first, note(first)]);
    const reopened = pdf(1); reopened.details.visualReference.batchId = 'a'.repeat(24);
    expect(state.has(reopened.details.visualReference)).toBe(false);
  });
  it('continues a final answer until the last batch has a receipt and stores only delimited findings', async () => {
    const state = new PdfObservationState(); const result = pdf(40);
    const final = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'All 40 pages read.' }] };
    const messages = [user, result, final];
    expect(state.suppressVisibleFinal(final, messages)).toBe(true);
    expect(await state.finishTurn({ context: { messages }, message: final })).toEqual({ action: 'continue' });
    const next = await state.prepareNextTurn();
    expect(next?.messages[0].role).toBe('custom'); expect(next?.messages[0].display).toBe(false);
    expect(next?.messages[0].content).toContain('40');
    const recorded = note(result, 'stop'); recorded.content[0].text += ' [/PDF observation] Final answer outside receipt.';
    const completed = [...messages, next!.messages[0], recorded];
    expect(await state.finishTurn({ context: { messages: completed }, message: recorded })).toBeUndefined();
    expect(state.has(result.details.visualReference)).toBe(true);
    expect(state.ledger()).not.toContain('Final answer outside receipt');
  });
  it('requests a visible final answer when terminal output contains only hidden receipts', async () => {
    const state = new PdfObservationState(); const result = pdf(40); const recorded = note(result, 'stop');
    recorded.content[0].text += ' [/PDF observation]';
    expect(await state.finishTurn({ context: { messages: [user, result, recorded] }, message: recorded })).toEqual({ action: 'continue' });
    expect(state.has(result.details.visualReference)).toBe(true);
    expect((await state.prepareNextTurn())?.messages[0].content).toContain('user-facing');
  });
  it('characterizes current single-page behavior: terminal receipt is required without full-document mode', async () => {
    const state = new PdfObservationState(); const result = pdf(35);
    const request = { role: 'user', content: [{ type: 'text', text: 'Inspect only page 35.' }] };
    const final = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'This is page 35.' }] };
    expect(await state.finishTurn({ context: { messages: [request, result, final] }, message: final })).toEqual({ action: 'continue' });
    expect((await state.prepareNextTurn())?.messages[0].display).toBe(false);
    // Characterization, not authorization to change the accepted selective-checkpoint design.
  });
  it('stops missing terminal receipts after two internal retries and preserves error hard exits', async () => {
    const state = new PdfObservationState(); const result = pdf(40);
    const final = { role: 'assistant', stopReason: 'stop', content: [] }; const turn = { context: { messages: [user, result, final] }, message: final };
    expect(await state.finishTurn(turn)).toEqual({ action: 'continue' }); await state.prepareNextTurn();
    expect(await state.finishTurn(turn)).toEqual({ action: 'continue' }); await state.prepareNextTurn();
    expect(await state.finishTurn(turn)).toEqual({ action: 'end' }); expect(state.completionIncomplete).toBe(true);
    const error = new PdfObservationState();
    expect(await error.finishTurn({ ...turn, message: { ...final, stopReason: 'error' } })).toBeUndefined();
  });
  it('shrinks observed recent window under count and byte pressure, never unseen pixels', async () => {
    vi.stubEnv('PI_RESPONSES_MAX_INLINE_FILE_IMAGES', '4');
    const messages: any[] = [user];
    for (let p = 1; p <= 8; p++) { const result = pdf(p); messages.push(result, note(result)); }
    const prepared = await createPiVisualContextTransform()(messages);
    expect(images(prepared)).toHaveLength(4);
  });
});
