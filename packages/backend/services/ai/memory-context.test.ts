import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, getMemoryCardsForContextMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getMemoryCardsForContextMock: vi.fn(),
}));

vi.mock('../../db/pg-repo.js', () => ({
  query: queryMock,
}));

vi.mock('./session-memory-card.js', () => ({
  getMemoryCardsForContext: getMemoryCardsForContextMock,
}));

import { __memoryContextTest, buildMemoryContext } from './memory-context.js';

describe('buildMemoryContext', () => {
  beforeEach(() => {
    queryMock.mockReset();
    getMemoryCardsForContextMock.mockReset();
    getMemoryCardsForContextMock.mockResolvedValue([]);
  });

  it('returns null without a user id because personal memory cannot be safely scoped', async () => {
    const result = await buildMemoryContext({
      sessionId: 's-current',
      userId: null,
      projectId: 'p1',
      cwd: '/home/tower/tower',
      projectLabel: 'tower',
    });

    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('queries only same user, same project, excluding current session', async () => {
    queryMock
      .mockResolvedValueOnce([
        {
          id: 's-old',
          name: 'old session',
          summary: '최근 런타임 박스 작업',
          files_edited: '["/home/tower/tower/packages/backend/a.ts"]',
          updated_at: '2026-06-08 12:00:00+09',
          turn_count: 4,
        },
      ])
      .mockResolvedValueOnce([
        {
          session_id: 's-old',
          session_name: 'old session',
          file_path: '/home/tower/tower/packages/backend/a.ts',
          tool_name: 'Edit',
          touched_at: '2026-06-08 12:01:00+09',
        },
      ]);

    const result = await buildMemoryContext({
      sessionId: 's-current',
      userId: 7,
      projectId: 'p1',
      cwd: '/home/tower/tower',
      projectLabel: 'Tower Development',
    });

    expect(result).toContain('<memory-context project="Tower Development" scope="personal-user-project" source="tower-pg" version="2">');
    expect(result).toContain('## 최근 작업 힌트');
    expect(result).toContain('최근 런타임 박스 작업');
    expect(result).toContain('자세한 과거 맥락이 필요하면 memory_search를 사용한다.');
    expect(result).not.toContain('[a.ts] old session via Edit');

    expect(getMemoryCardsForContextMock).toHaveBeenCalledWith({ userId: 7, projectId: 'p1', sessionId: 's-current', limit: 3 });
    expect(queryMock).toHaveBeenCalledTimes(2);
    for (const [, params] of queryMock.mock.calls) {
      expect(params).toEqual([7, 's-current', 'p1']);
    }
    expect(queryMock.mock.calls[0][0]).toContain('s.user_id = $1');
    expect(queryMock.mock.calls[0][0]).toContain('s.id <> $2');
    expect(queryMock.mock.calls[0][0]).toContain('s.project_id = $3');
  });

  it('uses continuity cards before fallback session summaries', async () => {
    getMemoryCardsForContextMock.mockResolvedValueOnce([
      {
        session_id: 's-old',
        user_id: 7,
        project_id: 'p1',
        title: '메모리 카드 도입',
        outcome: '세션당 continuity card를 만들기로 결정했다.',
        next_actions: ['session_memory_cards migration 구현'],
        touched_files: ['memory-context.ts'],
        cautions: ['project memory와 personal memory를 섞지 말 것'],
        artifacts: ['~/workspace/decisions/2026-06-09-session-continuity-cards.md'],
        decisions: [],
        pain_points: [],
        resolved: [],
        steps_taken: [],
        covered_turn_count: 4,
        covered_message_id: 'm1',
        covered_message_created_at: '2026-06-09 10:00:00+09',
        model: 'mini',
        confidence: 'high',
        revision: 1,
        updated_at: '2026-06-09 10:00:00+09',
      },
    ]);
    queryMock.mockResolvedValueOnce([]);

    const result = await buildMemoryContext({
      sessionId: 's-current',
      userId: 7,
      projectId: 'p1',
      cwd: '/home/tower/tower',
      projectLabel: 'tower',
    });

    expect(result).toContain('## 최근 작업 힌트');
    expect(result).toContain('메모리 카드 도입');
    expect(result).toContain('세션당 continuity card를 만들기로 결정했다.');
    expect(result).toContain('자세한 과거 맥락이 필요하면 memory_search를 사용한다.');
    expect(result).not.toContain('## 최근 산출물/결정');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to exact cwd only for project-less sessions', async () => {
    queryMock.mockResolvedValue([]);

    await buildMemoryContext({
      sessionId: 's-current',
      userId: 7,
      projectId: null,
      cwd: '/home/tower/workspace/projects/general',
      projectLabel: 'general',
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0]).toContain('s.project_id IS NULL');
    expect(queryMock.mock.calls[0][0]).toContain('s.cwd = $3');
    expect(queryMock.mock.calls[0][1]).toEqual([7, 's-current', '/home/tower/workspace/projects/general']);
  });

  it('does not leak malformed files_edited JSON into output', async () => {
    queryMock
      .mockResolvedValueOnce([
        {
          id: 's-old',
          name: 'old session',
          summary: null,
          files_edited: 'not-json',
          updated_at: '2026-06-08 12:00:00+09',
          turn_count: 2,
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await buildMemoryContext({
      sessionId: 's-current',
      userId: 7,
      projectId: 'p1',
      cwd: '/home/tower/tower',
      projectLabel: 'tower',
    });

    expect(result).toContain('old session');
    expect(result).not.toContain('not-json');
  });
});

describe('__memoryContextTest', () => {
  it('escapes XML attribute values', () => {
    expect(__memoryContextTest.escapeXml('A & B < C "D"')).toBe('A &amp; B &lt; C &quot;D&quot;');
  });

  it('formats Date objects as ISO dates', () => {
    expect(__memoryContextTest.formatDate(new Date('2026-06-09T04:10:00Z'))).toBe('2026-06-09');
  });
});
