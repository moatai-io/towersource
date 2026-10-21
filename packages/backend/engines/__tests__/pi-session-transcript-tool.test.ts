import { beforeEach, describe, expect, it, vi } from 'vitest';

const { canAccessSessionMock, getMessagesPaginatedMock, getSessionByKeyMock } = vi.hoisted(() => ({
  canAccessSessionMock: vi.fn(),
  getMessagesPaginatedMock: vi.fn(),
  getSessionByKeyMock: vi.fn(),
}));

vi.mock('../../services/pm/project-access.js', () => ({ canAccessSession: canAccessSessionMock }));
vi.mock('../../services/message-store.js', () => ({ getMessagesPaginated: getMessagesPaginatedMock }));
vi.mock('../../services/session/session-manager.js', () => ({ getSessionByKey: getSessionByKeyMock }));

import { createSessionTranscriptReadTool, fitTranscriptToContext } from '../pi-session-transcript-tool.js';

describe('Pi session_transcript_read tool', () => {
  beforeEach(() => {
    canAccessSessionMock.mockReset();
    getMessagesPaginatedMock.mockReset();
    getSessionByKeyMock.mockReset();
  });

  it('describes the admin exception without promising blanket operator access', () => {
    const tool = createSessionTranscriptReadTool({ userId: 7, userRole: 'operator' });

    expect(tool.description).toContain('Platform admins have a session-read exception');
    expect(tool.description).toContain('Operators do not have blanket access');
    expect(tool.description).toContain('An internal session link does not grant access');
    expect(tool.description).toContain('instead of using WebFetch');
    expect(tool.description).not.toContain('Admin/operator may read any session');
  });

  it('returns only visible user/assistant text and pagination metadata', async () => {
    canAccessSessionMock.mockResolvedValueOnce({ allowed: true });
    getMessagesPaginatedMock.mockResolvedValueOnce({
      messages: [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: '질문입니다.' }], created_at: '2026-07-13T01:00:00Z' },
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '최종 답변입니다.' }, { type: 'tool_use', name: 'bash' }], created_at: '2026-07-13T01:01:00Z' },
        { id: 't1', role: 'tool', content: [{ type: 'text', text: '비밀 도구 출력' }] },
        { id: 'a2', role: 'assistant', content: [{ type: 'commentary', text: '숨겨진 내부 진행' }] },
        { id: 'a3', role: 'assistant', content: [{ type: 'commentary', text: 'Worker 서비스를 확인하겠습니다.', phase: 'commentary', visibility: 'progress' }] },
        { id: 'u2', role: 'user', content: [{ type: 'text', text: '숨김 입력' }], metadata: { hidden: 'system-trigger' } },
      ],
      hasMore: true,
      oldestId: 'u1',
    });

    const tool = createSessionTranscriptReadTool({ userId: 7, userRole: 'admin' });
    const result = await tool.execute('call-1', { session_id: 'session-1', limit: 50 });

    expect(canAccessSessionMock).toHaveBeenCalledWith('session-1', 7, 'admin');
    expect(getMessagesPaginatedMock).toHaveBeenCalledWith('session-1', { limit: 50, before: undefined });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('질문입니다.');
    expect(result.content[0].text).toContain('최종 답변입니다.');
    expect(result.content[0].text).not.toContain('비밀 도구 출력');
    expect(result.content[0].text).not.toContain('숨겨진 내부 진행');
    expect(result.content[0].text).toContain('Worker 서비스를 확인하겠습니다.');
    expect(result.content[0].text).not.toContain('[진행]');
    expect(result.content[0].text).not.toContain('숨김 입력');
    expect(result.details).toMatchObject({ hasMore: true, oldestId: 'u1' });
  });

  it('returns a complete short transcript when it fits below half the context', () => {
    const messages = [
      { id: 'u1', shortId: null, role: 'user' as const, text: '짧은 질문', username: null, createdAt: null },
      { id: 'a1', shortId: null, role: 'assistant' as const, text: '짧은 답변', username: null, createdAt: null },
    ];

    const fitted = fitTranscriptToContext(messages, 10_000);

    expect(fitted.truncated).toBe(false);
    expect(fitted.omittedMessages).toBe(0);
    expect(fitted.rendered.join('\n')).toContain('짧은 질문');
    expect(fitted.rendered.join('\n')).toContain('짧은 답변');
  });

  it('keeps newest transcript content within roughly half the model context', async () => {
    canAccessSessionMock.mockResolvedValueOnce({ allowed: true });
    getMessagesPaginatedMock.mockResolvedValueOnce({
      messages: [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: `old-${'가'.repeat(12_000)}` }] },
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: `middle-${'나'.repeat(12_000)}` }] },
        { id: 'u2', role: 'user', content: [{ type: 'text', text: `newest-${'다'.repeat(3_000)}` }] },
      ],
      hasMore: false,
      oldestId: 'u1',
    });

    const tool = createSessionTranscriptReadTool({ userId: 7, userRole: 'admin', modelContextWindow: 10_000 });
    const result = await tool.execute('call-budget', { session_id: 'long-session' });
    const output = result.content[0].text;

    expect(output.length).toBeLessThanOrEqual(20_500); // 10k tokens × 50% × ~4 chars, plus header.
    expect(output).toContain('truncated=true');
    expect(output).toContain('newest-');
    expect(output).not.toContain('old-');
  });

  it('uses a 20-message page by default and supports older-page cursors', async () => {
    canAccessSessionMock.mockResolvedValueOnce({ allowed: true });
    getMessagesPaginatedMock.mockResolvedValueOnce({
      messages: [
        { id: 'u1', role: 'user', content: '[{"type":"text","text":"사용자 문장"}]' },
        { id: 'a1', role: 'assistant', content: '[{"type":"text","text":"AI 문장"}]' },
      ],
      hasMore: false,
      oldestId: 'u1',
    });

    const tool = createSessionTranscriptReadTool({ userId: 8, userRole: 'member' });
    const result = await tool.execute('call-2', { session_id: 'session-2', roles: ['assistant'], before: 'cursor-1' });

    expect(getMessagesPaginatedMock).toHaveBeenCalledWith('session-2', { limit: 20, before: 'cursor-1' });
    expect(result.content[0].text).toContain('AI 문장');
    expect(result.content[0].text).not.toContain('사용자 문장');
  });

  it('resolves an 8-character short code before applying access checks and reading messages', async () => {
    getSessionByKeyMock.mockResolvedValueOnce({ id: 'canonical-session-id', shortCode: 'ehre4g4p' });
    canAccessSessionMock.mockResolvedValueOnce({ allowed: true });
    getMessagesPaginatedMock.mockResolvedValueOnce({
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'short code transcript' }] }],
      hasMore: false,
      oldestId: 'u1',
    });

    const tool = createSessionTranscriptReadTool({ userId: 8, userRole: 'member' });
    const result = await tool.execute('call-short-code', { session_id: 'ehre4g4p' });

    expect(getSessionByKeyMock).toHaveBeenCalledWith('ehre4g4p', 8);
    expect(canAccessSessionMock).toHaveBeenCalledWith('canonical-session-id', 8, 'member');
    expect(getMessagesPaginatedMock).toHaveBeenCalledWith('canonical-session-id', { limit: 20, before: undefined });
    expect(result.content[0].text).toContain('short code transcript');
    expect(result.details).toMatchObject({ sessionId: 'canonical-session-id', sessionKey: 'ehre4g4p' });
  });

  it('fails closed when a short code does not resolve', async () => {
    getSessionByKeyMock.mockResolvedValueOnce(null);
    const tool = createSessionTranscriptReadTool({ userId: 8, userRole: 'member' });
    const result = await tool.execute('call-missing-short-code', { session_id: 'ehre4g4p' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('session not found for short code');
    expect(canAccessSessionMock).not.toHaveBeenCalled();
    expect(getMessagesPaginatedMock).not.toHaveBeenCalled();
  });

  it.each(['member', 'operator'])('denies inaccessible sessions for %s without loading messages', async (userRole) => {
    canAccessSessionMock.mockResolvedValueOnce({ allowed: false, status: 403, message: 'Access denied: private session' });
    const tool = createSessionTranscriptReadTool({ userId: 8, userRole });
    const result = await tool.execute('call-3', { session_id: 'private-session' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('403');
    expect(canAccessSessionMock).toHaveBeenCalledWith('private-session', 8, userRole);
    expect(getMessagesPaginatedMock).not.toHaveBeenCalled();
  });

  it('refuses unauthenticated use', async () => {
    const tool = createSessionTranscriptReadTool({ userId: undefined, userRole: 'member' });
    const result = await tool.execute('call-4', { session_id: 'session-1' });

    expect(result.isError).toBe(true);
    expect(canAccessSessionMock).not.toHaveBeenCalled();
  });
});
