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
  it('extracts the standard Work Summary fields and artifacts in any conversation language', () => {
    const report = parseWorkReportBlock([{ type: 'text', text: `완료했습니다.

Work Summary:
- Outcome: TodoWrite는 live progress로 낮추고 Work Summary를 최근 업무 원천으로 삼았습니다.
- Artifacts: \`~/workspace/decisions/2026-08-04-recent-work-from-work-report.md\`, packages/backend/services/work/work-report-ledger.ts
- Next: parser를 WorkLedger 후보 추출 경로에 연결합니다.

다른 문장` }]);

    expect(report).toMatchObject({
      conclusion: 'TodoWrite는 live progress로 낮추고 Work Summary를 최근 업무 원천으로 삼았습니다.',
      next: 'parser를 WorkLedger 후보 추출 경로에 연결합니다.',
    });
    expect(report?.artifacts).toContain('~/workspace/decisions/2026-08-04-recent-work-from-work-report.md');
    expect(report?.artifacts).toContain('packages/backend/services/work/work-report-ledger.ts');
  });

  it('accepts bold Work Summary labels emitted in final answers', () => {
    expect(parseWorkReportBlock(`작업을 마쳤습니다.\n\n**Work Summary:**\n- 내비게이션을 대화·업무·파일로 정렬했습니다.\n- 관련 테스트를 통과했습니다.`)).toMatchObject({
      conclusion: '내비게이션을 대화·업무·파일로 정렬했습니다.',
      bullets: [
        '내비게이션을 대화·업무·파일로 정렬했습니다.',
        '관련 테스트를 통과했습니다.',
      ],
    });
  });

  it('accepts quoted or listed report labels without depending on Korean wording', () => {
    expect(parseWorkReportBlock(`> **Work Summary:**\n- Outcome: quoted label indexed.`)).toMatchObject({
      conclusion: 'quoted label indexed.',
    });
  });

  it('uses the final report block when earlier text contains a format example', () => {
    expect(parseWorkReportBlock(`작성 예시:\n\nWork Summary:\n- Outcome: 무엇을 판단하거나 완료했는가.\n\n실제 작업을 마쳤습니다.\n\n**Work Summary:**\n- Outcome: 실제 내비게이션 구현을 완료했습니다.\n- Next: 회귀 테스트를 실행합니다.`)).toMatchObject({
      conclusion: '실제 내비게이션 구현을 완료했습니다.',
      next: '회귀 테스트를 실행합니다.',
    });
  });

  it('keeps legacy 업무보고 blocks readable', () => {
    expect(parseWorkReportBlock(`업무보고:\n- 결론: 기존 기록 호환\n- 산출물: packages/backend/legacy.ts\n- 다음: 새 형식으로 전환`)).toMatchObject({
      conclusion: '기존 기록 호환',
      artifacts: ['packages/backend/legacy.ts'],
      next: '새 형식으로 전환',
    });
  });

  it('accepts English field aliases case-insensitively', () => {
    expect(parseWorkReportBlock(`## work summary\n- RESULT: Indexed successfully.\n- FILES: packages/backend/index.ts\n- NEXT STEPS: Verify UI projection.`)).toMatchObject({
      conclusion: 'Indexed successfully.',
      artifacts: ['packages/backend/index.ts'],
      next: 'Verify UI projection.',
    });
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

  it('writes a compact manual WorkLedger row for an assistant Work Summary', async () => {
    queryOneMock.mockResolvedValueOnce({ project_id: 'p1', user_id: 7, session_name: 'Recent work session' });

    const indexed = await indexWorkReportMessage({
      sessionId: 's1',
      messageId: 'a1',
      role: 'assistant',
      content: [{ type: 'text', text: `Work Summary:
- Outcome: 최근 업무를 Work Summary 라벨로 색인합니다.
- Artifacts: \`~/workspace/projects/tower/work/report.md\`
- Next: UI projection을 조정합니다.` }],
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
      outcome: '최근 업무를 Work Summary 라벨로 색인합니다.',
      artifacts: ['~/workspace/projects/tower/work/report.md'],
      backlog: [{ type: 'task', title: 'UI projection을 조정합니다.' }],
    }));
    expect(upsertWorkLedgerRecordMock.mock.calls[0][0].sourceRefs).toMatchObject({
      kind: 'work_report',
      assistantMessageId: 'a1',
      parserVersion: 2,
    });
  });

  it('does not index non-assistant messages', async () => {
    const indexed = await indexWorkReportMessage({ sessionId: 's1', messageId: 'u1', role: 'user', content: 'Work Summary:\n- Outcome: no' });
    expect(indexed).toBe(false);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(upsertWorkLedgerRecordMock).not.toHaveBeenCalled();
  });

  it('indexes streamed assistant updates by looking up message context', async () => {
    queryOneMock.mockResolvedValueOnce({ session_id: 's1', role: 'assistant', project_id: 'p1', user_id: 7, session_name: 'Session' });

    const indexed = await indexWorkReportMessageUpdate('a2', [{ type: 'text', text: `Work Summary:
- Outcome: streaming update indexed.` }]);

    expect(indexed).toBe(true);
    expect(upsertWorkLedgerRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'work-report:a2',
      sessionId: 's1',
      outcome: 'streaming update indexed.',
    }));
  });
});
