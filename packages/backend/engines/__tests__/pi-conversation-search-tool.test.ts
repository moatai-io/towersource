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
