import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const query = vi.fn();
const queryOne = vi.fn();
const recordMessagePaths = vi.fn();
const indexWorkReportMessage = vi.fn();
const indexWorkReportMessageUpdate = vi.fn();
const generateShortCode = vi.fn(() => 'abc12345');

vi.mock('../db/pg-repo.js', () => ({ execute, query, queryOne }));
vi.mock('./workspace/message-path-extractor.js', () => ({ recordMessagePaths }));
vi.mock('./session/short-code.js', () => ({ generateShortCode }));
vi.mock('./work/work-report-ledger.js', () => ({ indexWorkReportMessage, indexWorkReportMessageUpdate }));
vi.mock('./agent-turn/turn-supervisor.js', () => ({
  forceAgentTurnNeedsAttention: vi.fn(),
  registerAgentTurn: vi.fn(),
  settleAgentTurn: vi.fn(),
  updateUnclaimedAgentTurn: vi.fn(),
}));

const { saveMessage } = await import('./message-store.js');

describe('message-store content compaction', () => {
  beforeEach(() => {
    execute.mockReset().mockResolvedValue(undefined);
    query.mockReset();
    queryOne.mockReset();
    recordMessagePaths.mockReset();
    indexWorkReportMessage.mockReset().mockResolvedValue(false);
    indexWorkReportMessageUpdate.mockReset().mockResolvedValue(false);
    generateShortCode.mockClear();
  });

  it('persists user-visible commentary while stripping thinking and hidden commentary', async () => {
    await saveMessage('session-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'private reasoning' },
        { type: 'commentary', text: 'Need internal planning.', phase: 'commentary', visibility: 'hidden' },
        { type: 'commentary', text: 'Worker 서비스를 확인하겠습니다.', phase: 'commentary', visibility: 'progress' },
        { type: 'text', text: '완료했습니다.' },
      ],
    });

    expect(execute).toHaveBeenCalled();
    const insertParams = execute.mock.calls[0][1];
    const persisted = JSON.parse(insertParams[3]);

    expect(persisted).toEqual([
      { type: 'commentary', text: 'Worker 서비스를 확인하겠습니다.', phase: 'commentary', visibility: 'progress' },
      { type: 'text', text: '완료했습니다.' },
    ]);
    expect(JSON.stringify(persisted)).not.toContain('private reasoning');
    expect(JSON.stringify(persisted)).not.toContain('Need internal planning');
  });
});
