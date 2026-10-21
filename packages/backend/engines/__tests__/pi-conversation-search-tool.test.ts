import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
}));

vi.mock('../../services/workspace/search.js', () => ({
  search: searchMock,
}));

import { createConversationSearchTool } from '../pi-conversation-search-tool.js';

describe('Pi conversation_search tool', () => {
  beforeEach(() => {
    searchMock.mockReset();
  });

  it('searches memory, sessions, and messages with scoped auth context', async () => {
    searchMock.mockResolvedValueOnce([
      {
        type: 'memory_card',
        sessionId: 's1',
        sessionShortCode: 'abc123',
        sessionName: 'Meeting prep',
        projectName: 'project-2',
        snippet: '회의 준비 정리',
        rank: 1,
        archived: false,
        createdAt: '2026-06-26T10:00:00Z',
        memoryTitle: 'meeting-prep 스킬 생성',
        memoryOutcome: '회의 전 목적과 참석자 기반 준비물을 정리했다.',
        memoryNextActions: ['샘플 추가'],
        memoryCautions: ['사용자 요청 없이 캘린더 조회 금지'],
      },
      {
        type: 'message',
        sessionId: 'm1',
        sessionShortCode: 'msg123',
        sessionName: 'Raw message hit',
        projectName: 'tower',
        snippet: 'task-schedule 수정 UI',
        rank: 1,
        createdAt: '2026-06-26T11:00:00Z',
      },
    ]);

    const tool = createConversationSearchTool({ userId: 7, userRole: 'admin', projectId: 'p1' });
    const result = await tool.execute('call-1', { query: '회의 스케줄', message_limit: 5 });

    expect(searchMock).toHaveBeenCalledWith('회의 스케줄', {
      userId: 7,
      role: 'admin',
      limit: 8,
      memoryLimit: 8,
      workLimit: 8,
      sessionLimit: 8,
      messageLimit: 5,
      includeArchived: false,
      deep: false,
      currentProjectId: 'p1',
    });
    expect(result.isError).not.toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('conversation_search results');
    expect(text).toContain('[project-2 · Meeting prep](');
    expect(text).toContain('/s/abc123)');
    expect(text).toContain('회의 전 목적과 참석자 기반 준비물을 정리했다.');
    expect(text).toContain('task-schedule 수정 UI');
  });

  it('groups TodoWrite and a nearby Work Summary while preserving structured work evidence', async () => {
    searchMock.mockResolvedValueOnce([
      {
        type: 'work', sessionId: 's-work', sessionShortCode: 'work1234', sessionName: '검색 점검', projectName: 'tower',
        snippet: '검색 개선 실행', rank: 2, createdAt: '2026-08-29T10:00:00Z', workId: 'w1', workstreamKey: 'search',
        workstreamTitle: 'Tower 검색 일관성 점검', runTitle: 'Work Ledger 검색 구현', workOutcome: '검색을 구현한다.',
        workStatus: 'completed', workSourceType: 'todowrite', workTodos: [{ content: '검색 구현', status: 'completed' }],
        workArtifacts: ['packages/backend/search.ts'],
      },
      {
        type: 'work', sessionId: 's-work', sessionShortCode: 'work1234', sessionName: '검색 점검', projectName: 'tower',
        snippet: '검색 구현을 완료했다.', rank: 1.5, createdAt: '2026-08-29T10:10:00Z', workId: 'w2', workstreamKey: 'work-report-x',
        workstreamTitle: '검색 구현을 완료했다.', runTitle: '검색 구현을 완료했다.', workOutcome: '검색 구현을 완료했다.',
        workStatus: 'completed', workSourceType: 'manual', workSourceKind: 'work_report', workArtifacts: ['work/audit.md'],
      },
    ]);

    const tool = createConversationSearchTool({ userId: 7, userRole: 'admin', projectId: 'p1' });
    const result = await tool.execute('call-work', { query: '검색 구현', work_limit: 10, memory_limit: 0, session_limit: 0, message_limit: 0 });
    const text = result.content[0].text;

    expect(text).toContain('work=1/2 raw');
    expect(text).toContain('출처**: TodoWrite + Work Summary');
    expect(text).toContain('**결과**: 검색 구현을 완료했다.');
    expect(text).toContain('[completed] 검색 구현');
    expect(text).toContain('packages/backend/search.ts; work/audit.md');
    expect(text).toContain('관련 기록**: 2건');
    expect(result.details).toMatchObject({ groupedWorkCount: 1 });
  });

  it('does not merge a Work Summary with a TodoWrite run more than 30 minutes away', async () => {
    searchMock.mockResolvedValueOnce([
      { type: 'work', sessionId: 's-work', sessionName: '세션', snippet: '첫 업무', rank: 2, createdAt: '2026-08-29T09:00:00Z', workId: 'w1', workstreamKey: 'a', runTitle: '첫 업무', workStatus: 'completed', workSourceType: 'todowrite' },
      { type: 'work', sessionId: 's-work', sessionName: '세션', snippet: '두 번째 결과', rank: 1, createdAt: '2026-08-29T11:00:00Z', workId: 'w2', workstreamKey: 'b', runTitle: '두 번째 결과', workStatus: 'completed', workSourceType: 'manual', workSourceKind: 'work_report' },
    ]);
    const tool = createConversationSearchTool({ userId: 7, userRole: 'admin', projectId: 'p1' });
    const result = await tool.execute('call-work-separate', { query: '업무 결과', work_limit: 10, memory_limit: 0, session_limit: 0, message_limit: 0 });
    expect(result.content[0].text).toContain('work=2/2 raw');
    expect(result.details).toMatchObject({ groupedWorkCount: 2 });
  });

  it('groups memory, session, and message hits for the same session and labels current-session self matches', async () => {
    searchMock.mockResolvedValueOnce([
      {
        type: 'memory_card', sessionId: 'current-session', sessionShortCode: 'ehre4g4p', sessionName: '검색 점검',
        projectName: 'tower', snippet: '검색 기억', memoryTitle: '검색 개선', memoryOutcome: '검색 흐름을 정리했다.',
        rank: 2, archived: false, createdAt: '2026-08-29T10:00:00Z',
      },
      {
        type: 'session', sessionId: 'current-session', sessionShortCode: 'ehre4g4p', sessionName: '검색 점검',
        projectName: 'tower', snippet: '세션 이름 매칭', rank: 1.5, archived: false, createdAt: '2026-08-29T09:00:00Z',
      },
      {
        type: 'message', sessionId: 'current-session', sessionShortCode: 'ehre4g4p', sessionName: '검색 점검',
        projectName: 'tower', snippet: '메시지 원문 매칭', rank: 1, archived: false, createdAt: '2026-08-29T11:00:00Z',
      },
    ]);

    const tool = createConversationSearchTool({ userId: 7, userRole: 'admin', projectId: 'p1', sessionId: 'current-session' });
    const result = await tool.execute('call-group', { query: '검색 점검' });
    const text = result.content[0].text;

    expect((text.match(/#### \[tower · 검색 점검\]/g) || [])).toHaveLength(1);
    expect(text).toContain('current session');
    expect(text).toContain('현재 대화의 자기 매칭');
    expect(text).toContain('**기억**: 검색 개선');
    expect(text).toContain('**세션 매칭**: 세션 이름 매칭');
    expect(text).toContain('**메시지 매칭**: 메시지 원문 매칭');
    expect(result.details).toMatchObject({ groupedSessionCount: 1 });
  });

  it('can search all accessible sessions without current project boost', async () => {
    searchMock.mockResolvedValueOnce([]);
    const tool = createConversationSearchTool({ userId: 7, userRole: 'member', projectId: 'p1' });

    await tool.execute('call-2', { query: 'meeting recorder', scope: 'all_accessible', include_archived: true, deep: true });

    expect(searchMock).toHaveBeenCalledWith('meeting recorder', expect.objectContaining({
      role: 'member',
      includeArchived: true,
      deep: true,
      currentProjectId: null,
      memoryLimit: 12,
      workLimit: 12,
      sessionLimit: 12,
      messageLimit: 30,
    }));
  });

  it('refuses unauthenticated use', async () => {
    const tool = createConversationSearchTool({ userId: undefined, userRole: 'member', projectId: 'p1' });
    const result = await tool.execute('call-3', { query: 'anything' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no authenticated Tower user');
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('partial conversation search', () => {
  it('warns even when a partial search has no hits', async () => {
    searchMock.mockResolvedValue(Object.assign([], { partial: true, failedSections: ['memory'] }));
    const result = await createConversationSearchTool({ userId: 7 }).execute('partial', { query: 'needle' });
    expect(JSON.stringify(result.content)).toContain('결과가 불완전');
    expect(JSON.stringify(result.content)).toContain('memory');
  });
});
