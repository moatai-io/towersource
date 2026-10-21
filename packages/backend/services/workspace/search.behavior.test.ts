import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQueryMock, accessibleProjectIdsMock } = vi.hoisted(() => ({
  pgQueryMock: vi.fn(),
  accessibleProjectIdsMock: vi.fn(),
}));

vi.mock('../../db/pg-repo.js', () => ({ query: pgQueryMock }));
vi.mock('../pm/project-membership-manager.js', () => ({
  getAccessibleProjectIds: accessibleProjectIdsMock,
}));

import { buildVisibilityFilter, search } from './search.js';

describe('workspace search section behavior', () => {
  beforeEach(() => {
    pgQueryMock.mockReset();
    accessibleProjectIdsMock.mockReset();
    accessibleProjectIdsMock.mockResolvedValue(['project-1']);
  });

  it('skips disabled sections when their explicit limit is zero', async () => {
    const results = await search('검색 계약', {
      userId: 7,
      role: 'member',
      memoryLimit: 0,
      workLimit: 0,
      sessionLimit: 0,
      messageLimit: 0,
    });

    expect(results).toEqual([]);
    expect(accessibleProjectIdsMock).toHaveBeenCalledWith(7, 'member');
    expect(pgQueryMock).not.toHaveBeenCalled();
  });

  it('runs message fallback even when the tsvector session section has a hit', async () => {
    pgQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("to_tsvector('simple', coalesce(s.name,'')))")) return [];
      if (sql.includes('FROM sessions s') && sql.includes('ts_rank_cd')) {
        return [{
          id: 'session-1', short_code: 'abc123', name: '검색 개선', project_id: 'project-1',
          project_name: 'Tower', summary: '검색 계약', created_at: '2026-08-29T00:00:00Z',
          archived: false, score: 1, snippet: '검색 계약', name_snippet: '검색 개선',
        }];
      }
      if (sql.includes('WITH recent_matches AS')) return [];
      if (sql.includes("WHERE (s.name ILIKE")) return [];
      if (sql.includes("WHERE m.content ILIKE")) {
        return [{
          id: 'message-1', content: '부분문자열 검색 계약을 확인했다.', session_id: 'session-1',
          created_at: '2026-08-29T01:00:00Z', session_name: '검색 개선',
          session_short_code: 'abc123', project_id: 'project-1', project_name: 'Tower', archived: false,
        }];
      }
      return [];
    });

    const results = await search('검색 계약', {
      userId: 7,
      role: 'member',
      memoryLimit: 0,
      workLimit: 0,
      sessionLimit: 5,
      messageLimit: 5,
    });

    expect(results.map((result) => result.type)).toEqual(['session', 'message']);
    expect(results[1]).toMatchObject({
      sessionId: 'session-1',
      projectId: 'project-1',
      snippet: expect.stringContaining('검색 계약'),
    });
    expect(pgQueryMock.mock.calls.some(([sql]) => String(sql).includes('WHERE m.content ILIKE'))).toBe(true);
  });

  it('searches Work Ledger text with the same accessible-project boundary', async () => {
    pgQueryMock.mockImplementation(async (sql: string, values: any[]) => {
      if (sql.includes('FROM work_ledger_records w')) {
        expect(sql).toContain('w.owner_user_id = $3');
        expect(sql).toContain('pm.project_id = s.project_id');
        expect(sql).toContain('s.id IS NOT NULL AND');
        expect(values).toEqual(['검색 계약', 5, 7, null]);
        return [{
          id: 'work-1', run_id: 'run-1', session_id: 'session-1', short_code: 'abc123',
          session_name: '검색 개선', project_id: 'project-1', project_name: 'Tower',
          workstream_key: 'search', workstream_title: '검색 일관성', run_title: 'fallback 개선',
          outcome: '검색 계약을 정렬했다.', note: null, status: 'completed', source_type: 'todowrite',
          source_refs: {}, todos: [{ content: '검색 수정', status: 'completed' }], artifacts: [], backlog: [], questions: [],
          activity_at: '2026-08-29T02:00:00Z', updated_at: '2026-08-29T02:00:00Z', archived: false, score: 1,
        }];
      }
      return [];
    });

    const results = await search('검색 계약', {
      userId: 7,
      role: 'member',
      memoryLimit: 0,
      workLimit: 5,
      sessionLimit: 0,
      messageLimit: 0,
    });

    expect(results).toEqual([expect.objectContaining({
      type: 'work', workId: 'work-1', workStatus: 'completed', sessionId: 'session-1',
      workTodos: [{ content: '검색 수정', status: 'completed' }],
    })]);
  });
});


describe('search audience protection before ranking and truncation', () => {
  beforeEach(() => {
    pgQueryMock.mockReset();
    accessibleProjectIdsMock.mockReset();
    accessibleProjectIdsMock.mockImplementation(async (_userId: number, role: string) => role === 'admin' || role === 'operator' ? null : ['joined-project']);
    pgQueryMock.mockResolvedValue([]);
  });
  it('does not use operator global project visibility as a conversation grant across all search paths', async () => {
    await search('private needle', { userId: 7, role: 'operator', memoryLimit: 2, sessionLimit: 2, messageLimit: 2, workLimit: 2 });
    expect(accessibleProjectIdsMock).toHaveBeenCalledWith(7, 'operator');
    // TSV session/memory/message/work and both ILIKE fallback queries.
    expect(pgQueryMock).toHaveBeenCalledTimes(6);
    for (const [sql, params] of pgQueryMock.mock.calls) {
      expect(sql).toContain('s.user_id = $3');
      expect(sql).toContain("s.visibility = 'project'");
      expect(sql).toContain('FROM room_members rm');
      expect(sql).not.toContain('FROM session_shares sh');
      expect(sql).not.toContain('administrator_participations');
      expect(sql.indexOf('s.user_id = $3')).toBeLessThan(sql.indexOf('LIMIT'));
      expect(params[2]).toEqual(7);
    }
  });
  it('does not grant missing-role or unauthenticated searches an unrestricted sentinel', async () => {
    await search('needle', { userId: 7, memoryLimit: 1, workLimit: 0, sessionLimit: 0, messageLimit: 0 });
    expect(accessibleProjectIdsMock).toHaveBeenCalledWith(7, 'member');
    pgQueryMock.mockClear();
    await search('needle', { memoryLimit: 1, workLimit: 0, sessionLimit: 0, messageLimit: 0 });
    expect(pgQueryMock.mock.calls[0][0]).toContain('AND FALSE');
  });
  it('binds linked Work Ledger audience to its source session, not project or work owner', async () => {
    await search('needle', { userId: 7, role: 'operator', workLimit: 1, memoryLimit: 0, sessionLimit: 0, messageLimit: 0 });
    const [sql] = pgQueryMock.mock.calls[0];
    expect(sql).toContain('LEFT JOIN sessions s ON s.id = w.session_id');
    expect(sql).toContain('s.id IS NOT NULL AND');
    expect(sql).toContain('s.id IS NULL AND w.owner_user_id = $3');
    expect(sql).not.toContain('w.project_id = ANY');
  });
  it('applies audience to platform admin too', async () => {
    await search('needle', { userId: 7, role: 'admin', memoryLimit: 1, workLimit: 0, sessionLimit: 0, messageLimit: 0 });
    expect(accessibleProjectIdsMock).toHaveBeenCalledWith(7, 'admin');
    expect(pgQueryMock.mock.calls[0][0]).toContain('FROM room_members rm');
  });
  it('uses channel membership before share/project while preserving owner and valid direct sharing', () => {
    const result = buildVisibilityFilter(['joined-project'], 7, 5);
    expect(result.params).toEqual([7]);
    expect(result.nextIdx).toBe(6);
    expect(result.clause).toContain('s.user_id = $5 OR CASE');
    expect(result.clause).toContain("WHEN s.room_id IS NOT NULL AND s.label IN ('channel_agent', 'channel_ai') THEN");
    expect(result.clause.indexOf('FROM room_members')).toBeLessThan(result.clause.indexOf('ELSE'));
    expect(result.clause).not.toContain('FROM session_shares');
    expect(result.clause).toContain('pm.user_id = $5');
  });
});

describe('search failure isolation and bounded freshness', () => {
  beforeEach(() => {
    pgQueryMock.mockReset();
    accessibleProjectIdsMock.mockResolvedValue(['project-1']);
  });

  it.each(['session', 'memory', 'message', 'work'] as const)('preserves other sections when %s fails', async (failed) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    pgQueryMock.mockImplementation(async (sql: string) => {
      const section = sql.includes('FROM work_ledger_records') ? 'work'
        : sql.includes('WITH card_docs') ? 'memory'
        : sql.includes('WITH recent_matches') ? 'message'
        : sql.includes('ts_rank_cd') ? 'session' : 'fallback';
      if (section === failed) throw new Error('sensitive driver detail');
      if (section === 'fallback') return [];
      return [{ id: section, session_id: section, name: section, content: 'needle', score: 1, title: section }];
    });
    try {
      const hits = await search('needle', { userId: 7, role: 'member', sessionLimit: 2, memoryLimit: 2, messageLimit: 2, workLimit: 2 });
      expect(hits).toHaveLength(3);
      expect(hits.partial).toBe(true);
      expect(hits.failedSections).toEqual([failed]);
      expect(JSON.parse(JSON.stringify(hits))).toHaveLength(3);
      expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive driver detail');
    } finally { log.mockRestore(); }
  });

  it('reports fallback failures instead of treating an outage as genuine no matches', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    pgQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ILIKE')) throw new Error('unavailable');
      return [];
    });
    try {
      const hits = await search('needle', { userId: 7, sessionLimit: 1, messageLimit: 0, memoryLimit: 0, workLimit: 0 });
      expect(hits).toHaveLength(0);
      expect(hits.failedSections).toEqual(['session']);
    } finally { log.mockRestore(); }
  });

  it('does not mark ordinary empty results as partial', async () => {
    pgQueryMock.mockResolvedValue([]);
    const hits = await search('needle', { userId: 7 });
    expect(hits.partial).toBeUndefined();
    expect(hits).toEqual([]);
  });

  it('applies the same bounded bonus to all four TSV sections, after ACL and before LIMIT', async () => {
    pgQueryMock.mockResolvedValue([]);
    await search('needle', { userId: 7 });
    const sqls = pgQueryMock.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.includes('ts_rank_cd'));
    expect(sqls).toHaveLength(4);
    for (const sql of sqls) {
      expect(sql).toContain('(1.0 + 0.2 * power(2.0, -GREATEST(0, EXTRACT(EPOCH FROM (NOW() -');
      expect(sql).toContain('/ (60 * 86400.0)))');
      expect(sql).not.toContain('* exp(');
      expect(sql.indexOf('s.user_id = $3')).toBeLessThan(sql.indexOf('LIMIT'));
    }
    const bonus = (days: number) => 1 + 0.2 * 2 ** (-Math.max(0, days) / 60);
    expect(bonus(0)).toBeCloseTo(1.2);
    expect(bonus(60)).toBeCloseTo(1.1);
    expect(bonus(180)).toBeCloseTo(1.025);
    expect(bonus(-1)).toBe(1.2);
    expect(2 * bonus(180)).toBeGreaterThan(1 * bonus(0));
  });
});
