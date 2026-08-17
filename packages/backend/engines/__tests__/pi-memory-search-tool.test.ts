import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
}));

vi.mock('../../services/workspace/search.js', () => ({
  search: searchMock,
}));

import { createMemorySearchTool } from '../pi-memory-search-tool.js';

describe('Pi memory_search tool', () => {
  beforeEach(() => {
    searchMock.mockReset();
  });

  it('searches only continuity memory cards by default in the current project scope', async () => {
    searchMock.mockResolvedValueOnce([
      {
        type: 'memory_card',
        sessionId: 's1',
        sessionShortCode: 'abc123',
        sessionName: 'Runtime Box credentials',
        projectName: 'tower',
        snippet: 'Credential Vault 주입을 정리함',
        rank: 1,
        archived: false,
        createdAt: '2026-06-16 10:00:00+09',
        memoryTitle: 'Runtime Box credential grant',
        memoryOutcome: 'Credential Vault 권한과 Runtime Box 주입 경로를 분리했다.',
        memoryNextActions: ['Runtime Box에서 허용/차단 프로젝트별 주입 확인'],
        memoryCautions: ['Vault Test와 프로젝트 연결을 혼동하지 말 것'],
      },
      {
        type: 'message',
        sessionId: 'm1',
        sessionName: 'Raw message hit',
        snippet: 'raw',
        rank: 1,
        createdAt: '2026-06-16',
      },
    ]);

    const tool = createMemorySearchTool({ userId: 7, userRole: 'admin', projectId: 'p1' });
    const result = await tool.execute('call-1', { query: 'runtime credential' });

    expect(searchMock).toHaveBeenCalledWith('runtime credential', {
      userId: 7,
      role: 'admin',
      limit: 5,
      memoryLimit: 5,
      sessionLimit: 1,
      messageLimit: 1,
      includeArchived: false,
      currentProjectId: 'p1',
    });
    expect(result.isError).not.toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('memory_search results');
    expect(text).toContain('/search (conversation-search)');
    expect(text).toContain('Runtime Box credential grant');
    expect(text).toContain('session: s1 (abc123)');
    expect(text).toContain('Vault Test와 프로젝트 연결을 혼동하지 말 것');
    expect(text).not.toContain('Raw message hit');
  });

  it('points to /search conversation-search when no memory cards are found', async () => {
    searchMock.mockResolvedValueOnce([]);
    const tool = createMemorySearchTool({ userId: 7, userRole: 'member', projectId: 'p1' });

    const result = await tool.execute('call-empty', { query: '없는 주제' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('/search (conversation-search)');
    expect(result.content[0].text).toContain('raw evidence');
  });

  it('can search all accessible sessions without current project boost', async () => {
    searchMock.mockResolvedValueOnce([]);
    const tool = createMemorySearchTool({ userId: 7, userRole: 'member', projectId: 'p1' });

    await tool.execute('call-2', {
      query: 'subagent quota',
      scope: 'all_accessible',
      limit: 10,
      include_archived: true,
    });

    expect(searchMock).toHaveBeenCalledWith('subagent quota', expect.objectContaining({
      role: 'member',
      memoryLimit: 10,
      includeArchived: true,
      currentProjectId: null,
    }));
  });

  it('refuses unauthenticated use', async () => {
    const tool = createMemorySearchTool({ userId: undefined, userRole: 'member', projectId: 'p1' });
    const result = await tool.execute('call-3', { query: 'anything' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no authenticated Tower user');
    expect(searchMock).not.toHaveBeenCalled();
  });
});
