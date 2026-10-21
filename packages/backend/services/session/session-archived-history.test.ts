import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const executeMock = vi.fn();
const queryOneMock = vi.fn();
const getAccessibleProjectIdsMock = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({
  query: (...args: any[]) => queryMock(...args),
  queryOne: (...args: any[]) => queryOneMock(...args),
  execute: (...args: any[]) => executeMock(...args),
}));

vi.mock('../pm/project-membership-manager.js', () => ({
  getAccessibleProjectIds: (...args: any[]) => getAccessibleProjectIdsMock(...args),
}));

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
  rehydratePiSessionFromMessages: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: { claudeEnabled: true, piEnabled: true, defaultEngine: 'pi' },
  normalizePiSessionModelId: (model: string | null | undefined) => model ?? null,
}));

const { getArchivedSessions } = await import('./session-manager.js');

function sessionRow(overrides: Record<string, any> = {}) {
  return {
    id: 'session-own',
    short_code: 'abc12345',
    claude_session_id: null,
    pi_session_file: null,
    name: 'My archived session',
    archived: 1,
    cwd: '/home/tower/workspace/projects/tower',
    tags: '[]',
    total_cost: 0,
    total_tokens: 0,
    created_at: new Date('2026-06-25T00:00:00Z'),
    updated_at: new Date('2026-06-26T00:00:00Z'),
    model_used: null,
    auto_named: 1,
    summary: null,
    summary_at_turn: null,
    turn_count: 1,
    user_turn_count: 0,
    files_edited: '[]',
    project_id: 'project-allowed',
    engine: 'pi',
    visibility: 'project',
    room_id: null,
    parent_session_id: null,
    source_message_id: null,
    owner_username: 'me',
    label: 'temp',
    agent_worker_id: null,
    kind: 'user',
    config_dir: null,
    last_auto_resume_at: null,
    user_id: 10,
    ...overrides,
  };
}

describe('getArchivedSessions', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryOneMock.mockReset();
    executeMock.mockReset();
    getAccessibleProjectIdsMock.mockReset();
  });

  it('scopes authenticated History SQL to the current user before mapping archived sessions', async () => {
    queryMock
      .mockResolvedValueOnce([sessionRow()])
      .mockResolvedValueOnce([{ session_id: 'session-own' }]);
    getAccessibleProjectIdsMock.mockResolvedValueOnce(null);

    const sessions = await getArchivedSessions(10, 'admin');

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('AND s.user_id = $1'),
      [10],
    );
    // History ordering follows the archive moment, falling back to legacy
    // updated_at for rows archived before archived_at existed.
    expect(queryMock.mock.calls[0][0]).toContain('ORDER BY COALESCE(s.archived_at, s.updated_at) DESC');
    expect(getAccessibleProjectIdsMock).toHaveBeenCalledWith(10, 'admin');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('session-own');
    expect(sessions[0].favorite).toBe(true);
    expect(sessions[0].archived).toBe(true);
  });

  it('preserves the no-auth/dev archived history fallback without user scoping', async () => {
    queryMock.mockResolvedValueOnce([sessionRow({ id: 'any-archived-session', user_id: 20 })]);

    const sessions = await getArchivedSessions(undefined, undefined);

    expect(queryMock).toHaveBeenCalledWith(
      expect.not.stringContaining('AND s.user_id = $1'),
      [],
    );
    expect(getAccessibleProjectIdsMock).not.toHaveBeenCalled();
    expect(sessions.map(s => s.id)).toEqual(['any-archived-session']);
  });
});
