import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer used by session-manager.
const queryMock = vi.fn();
const queryOneMock = vi.fn();
const executeMock = vi.fn();
const rehydratePiSessionFromMessagesMock = vi.hoisted(() => vi.fn());
const getOrPinSessionHarnessSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('../../db/pg-repo.js', () => ({
  query: (...args: any[]) => queryMock(...args),
  queryOne: (...args: any[]) => queryOneMock(...args),
  execute: (...args: any[]) => executeMock(...args),
}));

// Stub out group-manager (used by getSessions; not by the engine-switch helpers
// but session-manager imports it eagerly).
vi.mock('../pm/project-membership-manager.js', () => ({
  getAccessibleProjectIds: vi.fn(),
}));

// Stub workspace + credential-store + engines + config — same reason.
vi.mock('../workspace/jsonl-utils.js', () => ({
  findJsonlFileForSession: vi.fn(),
}));
vi.mock('../auth/credential-store.js', () => ({
  getConfigDir: vi.fn(async () => null),
}));
vi.mock('../../engines/index.js', () => ({
  getAllRunningSessionIds: vi.fn(() => []),
}));
vi.mock('../../engines/pi/rehydrate.js', () => ({
  rehydratePiSessionFromMessages: (...args: any[]) => rehydratePiSessionFromMessagesMock(...args),
}));
vi.mock('../harness/harness-store.js', () => ({
  getOrPinSessionHarnessSnapshot: (...args: any[]) => getOrPinSessionHarnessSnapshotMock(...args),
}));
vi.mock('../../config.js', () => ({
  config: { claudeEnabled: true, piEnabled: true, defaultEngine: 'pi' },
}));

const { recordEngineSwitch, getEngineSwitchHistory, cloneSession } = await import('./session-manager.js');

describe('recordEngineSwitch', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryOneMock.mockReset();
    executeMock.mockReset();
    rehydratePiSessionFromMessagesMock.mockReset();
  });

  it('updates sessions.engine, inserts history row, returns mapped record', async () => {
    queryOneMock.mockResolvedValueOnce({
      id: 42,
      session_id: 'sess-1',
      from_engine: 'claude',
      to_engine: 'pi',
      at_turn: 7,
      at_message_id: 'm-100',
      reason: 'user_request',
      from_session_id: 'claude-uuid-aaa',
      to_session_id: '/home/u/.pi/sessions/bbb.jsonl',
      switched_at: new Date('2026-05-19T10:00:00Z'),
      switched_by: 99,
    });

    const result = await recordEngineSwitch({
      sessionId: 'sess-1',
      fromEngine: 'claude',
      toEngine: 'pi',
      atTurn: 7,
      atMessageId: 'm-100',
      reason: 'user_request',
      fromSessionId: 'claude-uuid-aaa',
      toSessionId: '/home/u/.pi/sessions/bbb.jsonl',
      switchedBy: 99,
    });

    // 1. sessions row updated FIRST (before history insert)
    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sessions SET engine = $1'),
      ['pi', 'sess-1']
    );

    // 2. history row inserted
    expect(queryOneMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO session_engine_history'),
      ['sess-1', 'claude', 'pi', 7, 'm-100', 'user_request', 'claude-uuid-aaa', '/home/u/.pi/sessions/bbb.jsonl', 99]
    );

    // 3. result mapped to camelCase
    expect(result).toEqual({
      id: 42,
      sessionId: 'sess-1',
      fromEngine: 'claude',
      toEngine: 'pi',
      atTurn: 7,
      atMessageId: 'm-100',
      reason: 'user_request',
      fromSessionId: 'claude-uuid-aaa',
      toSessionId: '/home/u/.pi/sessions/bbb.jsonl',
      switchedAt: '2026-05-19T10:00:00.000Z',
      switchedBy: 99,
    });
  });

  it('rejects same-engine no-op (caller bug)', async () => {
    await expect(
      recordEngineSwitch({
        sessionId: 'sess-1',
        fromEngine: 'pi',
        toEngine: 'pi',
        atTurn: 3,
      })
    ).rejects.toThrow(/from_engine and to_engine are both 'pi'/);

    expect(executeMock).not.toHaveBeenCalled();
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('order: sessions UPDATE happens before history INSERT (avoid read inconsistency)', async () => {
    const callOrder: string[] = [];
    executeMock.mockImplementation(async () => { callOrder.push('execute'); });
    queryOneMock.mockImplementation(async () => {
      callOrder.push('queryOne');
      return {
        id: 1, session_id: 's', from_engine: 'claude', to_engine: 'pi',
        at_turn: 0, at_message_id: null, reason: null,
        from_session_id: null, to_session_id: null,
        switched_at: new Date(), switched_by: null,
      };
    });

    await recordEngineSwitch({
      sessionId: 's',
      fromEngine: 'claude',
      toEngine: 'pi',
      atTurn: 0,
    });

    expect(callOrder).toEqual(['execute', 'queryOne']);
  });

  it('throws when INSERT … RETURNING comes back empty (data integrity guard)', async () => {
    queryOneMock.mockResolvedValueOnce(null);

    await expect(
      recordEngineSwitch({
        sessionId: 'sess-1',
        fromEngine: 'claude',
        toEngine: 'pi',
        atTurn: 0,
      })
    ).rejects.toThrow(/INSERT returned no row/);
  });

  it('handles minimal input (no message id, no reason, no session ids, no user)', async () => {
    queryOneMock.mockResolvedValueOnce({
      id: 1,
      session_id: 's',
      from_engine: 'claude',
      to_engine: 'pi',
      at_turn: 0,
      at_message_id: null,
      reason: null,
      from_session_id: null,
      to_session_id: null,
      switched_at: new Date('2026-05-19T00:00:00Z'),
      switched_by: null,
    });

    const result = await recordEngineSwitch({
      sessionId: 's',
      fromEngine: 'claude',
      toEngine: 'pi',
      atTurn: 0,
    });

    // All optional fields passed as null to SQL
    expect(queryOneMock).toHaveBeenCalledWith(
      expect.any(String),
      ['s', 'claude', 'pi', 0, null, null, null, null, null]
    );
    expect(result.atMessageId).toBeNull();
    expect(result.reason).toBeNull();
    expect(result.switchedBy).toBeNull();
  });
});

describe('getEngineSwitchHistory', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryOneMock.mockReset();
    executeMock.mockReset();
  });

  it('returns newest-first, mapped to camelCase', async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: 3,
        session_id: 's',
        from_engine: 'pi',
        to_engine: 'claude',
        at_turn: 12,
        at_message_id: null,
        reason: 'user_request',
        from_session_id: null,
        to_session_id: null,
        switched_at: new Date('2026-05-19T12:00:00Z'),
        switched_by: 1,
      },
      {
        id: 2,
        session_id: 's',
        from_engine: 'claude',
        to_engine: 'pi',
        at_turn: 5,
        at_message_id: 'm-50',
        reason: 'user_request',
        from_session_id: null,
        to_session_id: null,
        switched_at: new Date('2026-05-19T10:00:00Z'),
        switched_by: 1,
      },
      {
        id: 1,
        session_id: 's',
        from_engine: null,
        to_engine: 'claude',
        at_turn: 0,
        at_message_id: null,
        reason: 'create',
        from_session_id: null,
        to_session_id: null,
        switched_at: new Date('2026-05-19T08:00:00Z'),
        switched_by: 1,
      },
    ]);

    const history = await getEngineSwitchHistory('s');

    expect(history).toHaveLength(3);
    expect(history[0].toEngine).toBe('claude');         // newest first
    expect(history[1].toEngine).toBe('pi');
    expect(history[2].fromEngine).toBeNull();           // create anchor
    expect(history[2].reason).toBe('create');

    // Query ordered DESC
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringMatching(/ORDER BY switched_at DESC/),
      ['s']
    );
  });

  it('returns empty array when session has no history', async () => {
    queryMock.mockResolvedValueOnce([]);
    const history = await getEngineSwitchHistory('unknown-sess');
    expect(history).toEqual([]);
  });
});

describe('cloneSession — Pi resume continuity', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryOneMock.mockReset();
    executeMock.mockReset();
    rehydratePiSessionFromMessagesMock.mockReset();
    getOrPinSessionHarnessSnapshotMock.mockReset();
    getOrPinSessionHarnessSnapshotMock.mockResolvedValue({ id: 'tower-default', version: 1 });
  });

  it('rehydrates copied DB messages into a fresh pi_session_file for Pi clones', async () => {
    rehydratePiSessionFromMessagesMock.mockResolvedValueOnce('/workspace/project/.pi/sessions/cloned.jsonl');

    queryOneMock
      .mockResolvedValueOnce({
        id: 'source-sess',
        short_code: 'SRC12345',
        claude_session_id: 'legacy-claude-id-that-must-not-be-used',
        pi_session_file: '/workspace/project/.pi/sessions/source.jsonl',
        name: '원본 세션',
        cwd: '/workspace/project',
        tags: '[]',
        total_cost: 0,
        total_tokens: 0,
        model_used: 'litellm-responses/smartest',
        auto_named: 1,
        summary: 'summary',
        summary_at_turn: 2,
        turn_count: 2,
        files_edited: '[]',
        engine: 'pi',
        visibility: 'project',
        room_id: null,
        project_id: 'project-1',
        source_message_id: null,
        parent_session_id: null,
        label: 'temp',
        config_dir: null,
        user_turn_count: 1,
        created_at: new Date('2026-06-11T00:00:00Z'),
        updated_at: new Date('2026-06-11T00:00:00Z'),
      })
      .mockResolvedValueOnce({ username: 'admin' })
      .mockResolvedValueOnce({
        id: 'new-sess',
        short_code: 'NEW12345',
        claude_session_id: null,
        pi_session_file: '/workspace/project/.pi/sessions/cloned.jsonl',
        name: '원본 세션 (복제)',
        cwd: '/workspace/project',
        tags: '[]',
        total_cost: 0,
        total_tokens: 0,
        model_used: 'litellm-responses/smartest',
        auto_named: 1,
        summary: 'summary',
        summary_at_turn: 2,
        turn_count: 2,
        files_edited: '[]',
        engine: 'pi',
        visibility: 'private',
        room_id: null,
        project_id: 'project-1',
        source_message_id: null,
        parent_session_id: null,
        label: 'temp',
        config_dir: null,
        user_turn_count: 1,
        created_at: new Date('2026-06-11T00:00:01Z'),
        updated_at: new Date('2026-06-11T00:00:01Z'),
      });

    executeMock.mockImplementation(async (sql: string) => {
      if (/INSERT INTO sessions/.test(sql)) return { changes: 1 };
      if (/INSERT INTO messages/.test(sql)) return { changes: 2 };
      if (/UPDATE sessions SET pi_session_file/.test(sql)) return { changes: 1 };
      return { changes: 1 };
    });

    queryMock.mockResolvedValueOnce([
      {
        id: 'u-1',
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: '원본 질문' }]),
        created_at: new Date('2026-06-11T00:00:00Z'),
        metadata: {},
      },
      {
        id: 'a-1',
        role: 'assistant',
        content: JSON.stringify([{ type: 'text', text: '원본 답변' }]),
        created_at: new Date('2026-06-11T00:00:01Z'),
        metadata: {},
      },
    ]);

    const cloned = await cloneSession('source-sess', 1);

    const insertSessionCall = executeMock.mock.calls.find(([sql]) => /INSERT INTO sessions/.test(sql));
    expect(insertSessionCall).toBeTruthy();
    const clonedSessionId = insertSessionCall?.[1][0];
    expect(clonedSessionId).toEqual(expect.any(String));
    expect(insertSessionCall?.[1][2]).toBeNull(); // Pi clone must not mint/use claude_session_id.

    const copyMessagesCall = executeMock.mock.calls.find(([sql]) => /INSERT INTO messages/.test(sql));
    expect(copyMessagesCall?.[0]).toContain('metadata, message_seq');
    expect(copyMessagesCall?.[0]).toContain("COALESCE(metadata->>'contextState', 'active') = 'active'");
    expect(copyMessagesCall?.[0]).toContain('ORDER BY message_seq ASC');
    expect(copyMessagesCall?.[1]).toEqual([clonedSessionId, 'source-sess']);
    expect(queryMock.mock.calls[0]?.[0]).toContain('ORDER BY message_seq ASC');

    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO session_runtime_snapshots'),
      [clonedSessionId, 'source-sess'],
    );
    expect(getOrPinSessionHarnessSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: clonedSessionId,
      projectId: 'project-1',
      requestedEngine: 'pi',
      requestedModel: 'litellm-responses/smartest',
      invocationKind: 'session',
    }));

    expect(rehydratePiSessionFromMessagesMock).toHaveBeenCalledWith(
      clonedSessionId,
      [
        expect.objectContaining({ id: 'u-1', role: 'user', content: [{ type: 'text', text: '원본 질문' }] }),
        expect.objectContaining({ id: 'a-1', role: 'assistant', content: [{ type: 'text', text: '원본 답변' }] }),
      ],
      '/workspace/project',
    );
    expect(executeMock).toHaveBeenCalledWith(
      'UPDATE sessions SET pi_session_file = $1 WHERE id = $2',
      ['/workspace/project/.pi/sessions/cloned.jsonl', clonedSessionId],
    );
    expect(cloned.engine).toBe('pi');
    expect(cloned.piSessionFile).toBe('/workspace/project/.pi/sessions/cloned.jsonl');
  });
});
