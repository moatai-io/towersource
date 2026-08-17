import { describe, expect, it, vi, beforeEach } from 'vitest';

const { queryOneMock, upsertWorkLedgerRecordMock } = vi.hoisted(() => ({
  queryOneMock: vi.fn(),
  upsertWorkLedgerRecordMock: vi.fn(),
}));

vi.mock('../../db/pg-repo.js', () => ({
  queryOne: queryOneMock,
}));

vi.mock('./work-ledger.js', () => ({
  upsertWorkLedgerRecord: upsertWorkLedgerRecordMock,
}));

import { indexWorkReportMessage, indexWorkReportMessageUpdate, parseWorkReportBlock } from './work-report-ledger.js';

describe('parseWorkReportBlock', () => {
  it('extracts the final 업무보고 block fields and artifacts', () => {
    const report = parseWorkReportBlock([{ type: 'text', text: `완료했습니다.

업무보고:
- 결론: TodoWrite는 live progress로 낮추고 업무보고를 최근 업무 원천으로 삼았습니다.
- 산출물: \`~/workspace/decisions/2026-08-04-recent-work-from-work-report.md\`, packages/backend/services/work/work-report-ledger.ts
- 다음: parser를 WorkLedger 후보 추출 경로에 연결합니다.

다른 문장` }]);

    expect(report).toMatchObject({
      conclusion: 'TodoWrite는 live progress로 낮추고 업무보고를 최근 업무 원천으로 삼았습니다.',
      next: 'parser를 WorkLedger 후보 추출 경로에 연결합니다.',
    });
    expect(report?.artifacts).toContain('~/workspace/decisions/2026-08-04-recent-work-from-work-report.md');
    expect(report?.artifacts).toContain('packages/backend/services/work/work-report-ledger.ts');
  });

  it('ignores ordinary assistant text without the label', () => {
    expect(parseWorkReportBlock([{ type: 'text', text: '그냥 짧은 답변입니다.' }])).toBeNull();
  });
});

describe('indexWorkReportMessage', () => {
  beforeEach(() => {
    queryOneMock.mockReset();
    upsertWorkLedgerRecordMock.mockReset();
    upsertWorkLedgerRecordMock.mockResolvedValue({ id: 'wl-1' });
  });

  it('writes a compact manual WorkLedger row for an assistant 업무보고', async () => {
    queryOneMock.mockResolvedValueOnce({ project_id: 'p1', user_id: 7, session_name: 'Recent work session' });

    const indexed = await indexWorkReportMessage({
      sessionId: 's1',
      messageId: 'a1',
      role: 'assistant',
      content: [{ type: 'text', text: `업무보고:
- 결론: 최근 업무를 업무보고 라벨로 색인합니다.
- 산출물: \`~/workspace/projects/tower/work/report.md\`
- 다음: UI projection을 조정합니다.` }],
    });

    expect(indexed).toBe(true);
    expect(upsertWorkLedgerRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'work-report:a1',
      projectId: 'p1',
      sessionId: 's1',
      ownerUserId: 7,
      sourceType: 'manual',
      sourceId: 'work-report:a1',
      status: 'completed',
      outcome: '최근 업무를 업무보고 라벨로 색인합니다.',
      artifacts: ['~/workspace/projects/tower/work/report.md'],
      backlog: [{ type: 'task', title: 'UI projection을 조정합니다.' }],
    }));
    expect(upsertWorkLedgerRecordMock.mock.calls[0][0].sourceRefs).toMatchObject({
      kind: 'work_report',
      assistantMessageId: 'a1',
      parserVersion: 1,
    });
  });

  it('does not index non-assistant messages', async () => {
    const indexed = await indexWorkReportMessage({ sessionId: 's1', messageId: 'u1', role: 'user', content: '업무보고:\n- 결론: no' });
    expect(indexed).toBe(false);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(upsertWorkLedgerRecordMock).not.toHaveBeenCalled();
  });

  it('indexes streamed assistant updates by looking up message context', async () => {
    queryOneMock.mockResolvedValueOnce({ session_id: 's1', role: 'assistant', project_id: 'p1', user_id: 7, session_name: 'Session' });

    const indexed = await indexWorkReportMessageUpdate('a2', [{ type: 'text', text: `업무보고:
- 결론: streaming update indexed.` }]);

    expect(indexed).toBe(true);
    expect(upsertWorkLedgerRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'work-report:a2',
      sessionId: 's1',
      outcome: 'streaming update indexed.',
    }));
  });
});
