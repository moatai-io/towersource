import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, indexWorkReportMessageMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  indexWorkReportMessageMock: vi.fn(),
}));

vi.mock('../db/pg-repo.js', () => ({ query: queryMock }));
vi.mock('../services/work/work-report-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/work/work-report-ledger.js')>();
  return { ...actual, indexWorkReportMessage: indexWorkReportMessageMock };
});

import { backfillWorkSummaryLedger, classifyWorkSummaryBackfill, collectWorkSummaryBackfillCandidates } from './backfill-work-summary-ledger.js';

describe('Work Summary WorkLedger backfill', () => {
  beforeEach(() => {
    queryMock.mockReset();
    indexWorkReportMessageMock.mockReset().mockResolvedValue(true);
  });

  it('keeps only messages that the canonical parser accepts', async () => {
    queryMock.mockResolvedValue([
      { message_id: 'm1', session_id: 's1', created_at: '2026-08-22T00:00:00Z', content: JSON.stringify([{ type: 'text', text: '**Work Summary:**\n- restored' }]), existing: false },
      { message_id: 'm2', session_id: 's2', created_at: '2026-08-22T01:00:00Z', content: 'Work Summary was discussed, but this is not a report.', existing: false },
    ]);

    const candidates = await collectWorkSummaryBackfillCandidates(30, 100);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ messageId: 'm1', sessionId: 's1', conclusion: 'restored', existing: false, eligible: false, exclusion: 'too_short' });
    expect(queryMock.mock.calls[0][0]).toContain("w.source_id = 'work-report:' || m.id");
    expect(queryMock.mock.calls[0][1]).toEqual([30, 100]);
  });

  it('is dry-run by default and does not write candidate rows', async () => {
    queryMock.mockResolvedValue([
      { message_id: 'm1', session_id: 's1', created_at: '2026-08-22T00:00:00Z', content: '**Work Summary:**\n- restored completed work', existing: false },
    ]);

    const summary = await backfillWorkSummaryLedger({ days: 30, limit: 100, apply: false });
    expect(summary).toMatchObject({ mode: 'dry-run', candidates: 1, existing: 0, missing: 1, eligible: 1, excluded: 0, indexed: 0, skipped: 0 });
    expect(summary.preview[0].sourceId).toBe('work-report:m1');
    expect(indexWorkReportMessageMock).not.toHaveBeenCalled();
  });

  it('replays through the canonical idempotent message indexer in apply mode', async () => {
    queryMock.mockResolvedValue([
      { message_id: 'm1', session_id: 's1', created_at: '2026-08-22T00:00:00Z', content: '**업무보고:**\n- 실제 완료 기록을 복구했습니다.', existing: false },
    ]);

    const summary = await backfillWorkSummaryLedger({ days: 30, limit: 100, apply: true });
    expect(summary).toMatchObject({ mode: 'apply', candidates: 1, existing: 0, missing: 1, eligible: 1, indexed: 1, skipped: 0 });
    expect(indexWorkReportMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', messageId: 'm1', role: 'assistant',
    }));
  });

  it('classifies placeholders, examples, and underspecified labels before apply', () => {
    expect(classifyWorkSummaryBackfill({ conclusion: '무엇을 판단하거나 완료했는가.', artifacts: [] }, false)).toBe('placeholder');
    expect(classifyWorkSummaryBackfill({ conclusion: '예시: 완료 내용을 적습니다.', artifacts: [] }, false)).toBe('format_example');
    expect(classifyWorkSummaryBackfill({ conclusion: '이어가기', artifacts: [] }, false)).toBe('placeholder');
    expect(classifyWorkSummaryBackfill({ conclusion: '완료', artifacts: [] }, false)).toBe('too_short');
    expect(classifyWorkSummaryBackfill({ conclusion: '실제 구현과 검증을 완료했습니다.', artifacts: [] }, false)).toBeNull();
  });

  it('does not replay rows that already have the canonical WorkLedger identity', async () => {
    queryMock.mockResolvedValue([
      { message_id: 'm1', session_id: 's1', created_at: '2026-08-22T00:00:00Z', content: '**Work Summary:**\n- already indexed', existing: true },
    ]);

    const summary = await backfillWorkSummaryLedger({ days: 30, limit: 100, apply: true });
    expect(summary).toMatchObject({ candidates: 1, existing: 1, missing: 0, indexed: 0 });
    expect(indexWorkReportMessageMock).not.toHaveBeenCalled();
  });
});
