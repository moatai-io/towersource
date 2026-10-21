import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { getSession, getSessions, getArchivedSessions, getSessionPanelSessions, getPanelSessions } = await import('./session-manager.js');
function sessionRow(overrides: Record<string, any> = {}) {
  return {
    id: 'session-own',
    short_code: 'abc12345',
    claude_session_id: null,
    pi_session_file: null,
    name: 'My archived session',
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
    current_user_participated: true,
    current_user_subscribed: true,
    unread_ai_response: true,
    last_final_ai_sequence: '3',
    last_read_ai_sequence: '2',
    label: 'temp',
    agent_worker_id: null,
    kind: 'user',
    config_dir: null,
    last_auto_resume_at: null,
    user_id: 10,
    ...overrides,
  };
}


describe('direct manager callers get audience-safe lists before LIMIT', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => { vi.clearAllMocks(); queryMock.mockReset(); vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '0'); });
  it('redacts unjoined company metadata and applies shared SQL audience before LIMIT without per-row queries', async () => {
    queryMock.mockResolvedValueOnce([
      sessionRow({ id: 'metadata', name: 'Company shared', transcript_readable: false, summary: 'must not escape', cwd: '/internal', user_id: 20 }),
      sessionRow({ id: 'readable', transcript_readable: true, summary: 'audience readable' }),
    ]).mockResolvedValueOnce([]);
    const rows = await getSessions(10, 'operator', { limit: 1 });
    expect(rows[0]).not.toHaveProperty('summary');
    expect(rows[0]).not.toHaveProperty('cwd');
    expect(rows[0]).toHaveProperty('name', 'Company shared');
    expect(rows[1]).toHaveProperty('summary', 'audience readable');
    expect(queryMock).toHaveBeenCalledTimes(2);
    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual([10, 1]);
    expect(sql).not.toContain('administrator_participations');
    expect(sql.indexOf("s.visibility = 'private' THEN FALSE")).toBeLessThan(sql.indexOf('project_members pm'));
    expect(sql).toContain("s.visibility = 'project'");
    expect(sql).toContain('AS transcript_readable');
    expect(sql).toContain('AS current_user_participated');
    expect(sql).toContain('participant_message.username = participant_user.username');
    expect(sql).toContain('LEFT JOIN session_user_states sus');
    expect(sql).toContain('AS unread_ai_response');
    expect(rows[1]).toMatchObject({
      currentUserParticipated: true,
      currentUserSubscribed: true,
      unreadAiResponse: true,
      lastFinalAiSequence: 3,
      lastReadAiSequence: 2,
    });
  });
  it('requires current Project membership for recent discovery even for owned sessions before LIMIT', async () => {
    queryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await getSessions(10, 'admin', { sidebarOnly: true, limit: 60 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual([10, 60]);
    expect(sql).toContain('s.user_id = $1 OR CASE');
    expect(sql).toContain('FROM project_members recent_pm WHERE recent_pm.project_id = s.project_id AND recent_pm.user_id = $1');
    expect(sql).toContain("legacy_admin.role = 'admin'");
    expect(sql).not.toContain('primary_email_identity_id');
    expect(sql.indexOf('FROM project_members recent_pm')).toBeLessThan(sql.indexOf('ORDER BY'));
    expect(sql.indexOf('FROM project_members recent_pm')).toBeLessThan(sql.indexOf('LIMIT'));
  });

  it('preserves transcript audience listing outside the recent sidebar', async () => {
    queryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await getSessions(10, 'admin');
    expect(queryMock.mock.calls[0][0]).not.toContain('recent_pm');
  });

  it('redacts nullable SQL audience for ownerless system metadata too', async () => {
    queryMock.mockResolvedValueOnce([sessionRow({ user_id: null, transcript_readable: null, summary: 'hidden system context' })]).mockResolvedValueOnce([]);
    expect((await getSessions(10, 'operator'))[0]).not.toHaveProperty('summary');
  });
  it('does not treat missing role or authentication as a global audience', async () => {
    queryMock.mockResolvedValue([]);
    await getSessions(10, undefined, { limit: 5 });
    expect(queryMock.mock.calls[0][0]).toContain('project_members');
    queryMock.mockClear();
    await getSessions(undefined, undefined, { limit: 5 });
    expect(queryMock.mock.calls[0][0]).toContain('(FALSE)');
  });
  it('uses the same private-first audience for admin lists and panels without bypass', async () => {
    queryMock.mockResolvedValue([]);
    await getSessions(10, 'admin', { limit: 5 });
    let sql = queryMock.mock.calls[0][0];
    expect(sql).toContain("s.visibility = 'private' THEN FALSE");
    expect(sql).not.toContain('$1::int IS NOT NULL');
    expect(sql.indexOf('project_members pm')).toBeLessThan(sql.indexOf('LIMIT'));
    expect(sql).not.toContain('session_shares');
    queryMock.mockClear();
    await getSessionPanelSessions('parent', 10, { role: 'admin', includeProject: true });
    sql = queryMock.mock.calls[0][0];
    expect(sql).toContain("s.visibility = 'private' THEN FALSE");
    expect(sql).not.toContain('WHERE TRUE');
  });
  it('adds only the team owner sidebar discovery path before LIMIT when enabled', async () => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
    queryMock.mockResolvedValue([]);
    await getSessions(10, 'member', { sidebarOnly: true, limit: 1 });
    const sql = queryMock.mock.calls[0][0];
    const discovery = sql.slice(sql.indexOf('recent_pm'), sql.indexOf('s.parent_session_id IS NULL'));
    expect(discovery).toContain('s.user_id = $1');
    expect(discovery).toContain('agent_team_projects sidebar_team');
    expect(sql.indexOf('sidebar_team')).toBeLessThan(sql.indexOf('LIMIT $2'));
    expect(sql).toContain('current_member'); // Current team use gates existing audience too.
    expect(getAccessibleProjectIdsMock).not.toHaveBeenCalled();
  });
  it('checks current team use for own archived history when enabled', async () => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
    queryMock.mockResolvedValue([]);
    getAccessibleProjectIdsMock.mockResolvedValue([]);
    await getArchivedSessions(10, 'member');
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toContain('AND s.user_id = $1');
    expect(sql).toContain('agent_team');
    expect(sql).toContain('current_member');
    expect(getAccessibleProjectIdsMock).toHaveBeenCalledWith(10, 'member');
  });
  it('denies unauthenticated archived scope when enabled', async () => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
    queryMock.mockResolvedValue([]);
    await getArchivedSessions();
    expect(queryMock.mock.calls[0][0]).toContain('AND FALSE');
  });
  it('retains the archived SQL and legacy postfilter when disabled', async () => {
    queryMock.mockResolvedValue([]);
    getAccessibleProjectIdsMock.mockResolvedValue([]);
    await getArchivedSessions(10, 'member');
    expect(queryMock.mock.calls[0][0]).not.toContain('agent_team');
    expect(getAccessibleProjectIdsMock).toHaveBeenCalledWith(10, 'member');
  });
  it('filters ownerless room panel sessions with channel membership, not automatic system ownership', async () => {
    queryMock.mockResolvedValue([]);
    await getPanelSessions('room', 10);
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toContain("s.visibility = 'private' THEN FALSE");
    expect(sql).toContain('room_members');
    expect(sql).not.toContain('administrator_participations');
  });
});


describe('single session participation metadata', () => {
  beforeEach(() => { vi.clearAllMocks(); queryMock.mockReset(); queryOneMock.mockReset(); });
  it('does not manufacture false participation when no actor was supplied', async () => {
    const row = sessionRow();
    const { current_user_participated: _participated, ...withoutParticipation } = row;
    queryOneMock.mockResolvedValue(withoutParticipation);
    const result = await getSession('s-1');
    expect(result).not.toHaveProperty('currentUserParticipated');
  });
  it('computes account participation for single-session retrieval too', async () => {
    queryOneMock.mockResolvedValue(sessionRow({ current_user_participated: true }));
    queryMock.mockResolvedValue([]);
    const result = await getSession('s-1', 10);
    expect(result?.currentUserParticipated).toBe(true);
    const [sql, params] = queryOneMock.mock.calls[0];
    expect(sql).toContain('session_user_states participant_state');
    expect(sql).toContain('participant_message.username = participant_user.username');
    expect(params).toEqual(['s-1', 10]);
  });
});
