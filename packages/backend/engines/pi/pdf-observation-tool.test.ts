import { describe, expect, it, vi } from 'vitest';
import { PdfObservationState, pdfBatchId } from './pdf-observation-state.js';
import { createPdfObservationTool } from './pdf-observation-tool.js';
const user = { role: 'user', content: [{ type: 'text', text: 'Review' }] };
function batch(page: number) {
  const ref = { version: 1, source: 'report.pdf', sourceVersion: 'v1', pages: [page], dpi: 144 };
  return { role: 'toolResult', toolName: 'pdf_view', details: { visualReference: { ...ref, batchId: pdfBatchId(ref) } }, content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] };
}
describe('structured PDF observations', () => {
  it('binds a single pending batch without copied identifiers and permits final completion', async () => {
    const state = new PdfObservationState(); const persist = vi.fn(); state.bindPersistence([], persist);
    const pdf = batch(1); state.observe([user, pdf]);
    const result: any = await createPdfObservationTool(state).execute('observe', { findings: 'Signature area is visible.', uncertainties: 'Small text needs closer inspection.' });
    expect(result.isError).toBe(false); expect(persist).toHaveBeenCalledTimes(1);
    expect(state.has(pdf.details.visualReference)).toBe(true);
    expect(state.suppressVisibleFinal({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Report ready.' }] }, [user, pdf])).toBe(false);
    const resumed = new PdfObservationState(); resumed.bindPersistence(persist.mock.calls.map(([data]) => data), vi.fn());
    expect(resumed.has(pdf.details.visualReference)).toBe(true);
  });
  it('never guesses between multiple pending batches', () => {
    const state = new PdfObservationState(); const a = batch(1); const b = batch(2); state.observe([user, a, b]);
    expect(state.recordObservation('Visible', '')).toMatchObject({ ok: false, code: 'AMBIGUOUS_BATCH' });
    expect(state.recordObservation('Visible', '', 'wrong')).toMatchObject({ ok: false, code: 'UNKNOWN_PENDING_BATCH' });
    expect(state.recordObservation('Page 2 visible', '', b.details.visualReference.batchId)).toMatchObject({ ok: true, pages: [2] });
    expect(state.has(a.details.visualReference)).toBe(false);
    expect(state.recordObservation('Page 1 visible', '')).toMatchObject({ ok: true, pages: [1] });
  });
  it('does not reuse prior-turn or failed tool batches', () => {
    const state = new PdfObservationState(); state.observe([user, batch(1), user, { ...batch(2), isError: true }]);
    expect(state.recordObservation('Visible', '')).toMatchObject({ code: 'NO_PENDING_BATCH' });
  });
  it('rejects empty findings and preserves the verification gate', () => {
    const state = new PdfObservationState(); const pdf = batch(1); state.observe([user, pdf]);
    expect(state.recordObservation(' ', '')).toMatchObject({ code: 'INVALID_OBSERVATION' });
    expect(state.has(pdf.details.visualReference)).toBe(false);
  });
});
