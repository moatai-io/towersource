import { describe, it, expect } from 'vitest';
import { PdfTaskOutcome } from './pdf-task-outcome.js';
describe('independent PDF task outcomes', () => {
  it('keeps generation and presentation successes when review is incomplete', () => {
    const state = new PdfTaskOutcome();
    state.observeToolResult('pdf_export', { details: { pdfExported: true, outputPath: '/project/report.pdf' } });
    state.observeToolResult('present_file', { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'present_file', path: '/project/report.pdf' }) }] });
    expect(state.snapshot(true)).toEqual({ generatedPaths: ['/project/report.pdf'], presentedPaths: ['/project/report.pdf'], review: 'incomplete' });
    expect(state.incompleteReviewNotice()).toContain('PDF 생성은 완료');
    expect(state.incompleteReviewNotice()).toContain('시각 검토 완료로 처리하지 않았습니다');
  });
  it('does not infer generation from presentation or advertise failed operations', () => {
    const state = new PdfTaskOutcome();
    state.observeToolResult('pdf_export', { isError: true, details: { pdfExported: true, outputPath: 'bad.pdf' } });
    state.observeToolResult('present_file', { content: [{ type: 'text', text: 'not json' }] });
    expect(state.snapshot(true)).toMatchObject({ generatedPaths: [], presentedPaths: [] });
    expect(state.incompleteReviewNotice()).not.toContain('생성은 완료');
    expect(state.incompleteReviewNotice()).not.toContain('링크는 채팅');
  });
});
