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

  it('truncates Pi-style tool_use.result before persisting assistant traces', async () => {
    const hugeResult = `HEAD\n${Array.from({ length: 5000 }, (_, i) => `line ${i}: ordinary shell output with spaces and punctuation`).join('\n')}\nTAIL`;

    await saveMessage('session-1', {
      id: 'assistant-tool-1',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'bash',
        input: { command: 'generate-large-output' },
        result: hugeResult,
      }],
    });

    const insertParams = execute.mock.calls[0][1];
    const persisted = JSON.parse(insertParams[3]);
    const storedResult = persisted[0].result as string;

    expect(storedResult.length).toBeLessThanOrEqual(50 * 1024);
    expect(storedResult).toMatch(/tool output truncated \d+KB → 50KB/);
    expect(storedResult).toMatch(/^HEAD\n/);
    expect(storedResult).toMatch(/\nTAIL$/);
    expect(storedResult).not.toBe(hugeResult);
  });

  it('keeps Pi-style tool_use.result unchanged when it is within the limit', async () => {
    await saveMessage('session-1', {
      id: 'assistant-tool-2',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-2', name: 'bash', input: {}, result: 'small output' }],
    });

    const insertParams = execute.mock.calls[0][1];
    const persisted = JSON.parse(insertParams[3]);
    expect(persisted[0].result).toBe('small output');
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

 describe('composer message context', () => {
  it.each([true, false])('bounds body loading with sequence capability %s', async (sequence) => {
    const { getComposerMessageContext, resetMessageOrderingCapabilityForTests } = await import('./message-store.js');
    resetMessageOrderingCapabilityForTests();
    queryOne.mockReset();
    if (sequence) queryOne.mockResolvedValueOnce({});
    else queryOne.mockRejectedValueOnce(Object.assign(new Error('missing column'), { code: '42703' }));
    queryOne.mockResolvedValueOnce({ content: '[]', context_revision: '123' });
    expect(await getComposerMessageContext('s1')).toEqual({ content: '[]', contextRevision: 123 });
    const [sql, params] = queryOne.mock.calls[1];
    expect(sql).toContain(sequence ? 'message_seq DESC' : 'created_at DESC, id DESC');
    expect(sql).toContain("role = 'assistant'");
    expect(sql).toContain('LIMIT 1');
    expect(sql.match(/contextState/g)).toHaveLength(2);
    expect(params).toEqual(['s1']);
  });
  it('returns null when no assistant exists', async () => {
    const { getComposerMessageContext } = await import('./message-store.js');
    queryOne.mockReset().mockResolvedValue({ content: null, context_revision: '2' });
    expect(await getComposerMessageContext('s')).toEqual({ content: null, contextRevision: 2 });
  });
});
