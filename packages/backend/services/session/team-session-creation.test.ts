import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), resolveContext: vi.fn(),
  subscribe: vi.fn(), harness: vi.fn(),
}));
vi.mock('../../db/pg-repo.js', () => ({ query: mocks.query, queryOne: mocks.queryOne, execute: mocks.execute }));
vi.mock('../agent-workspaces/team-context.js', () => ({ resolveTeamAgentContext: mocks.resolveContext }));
vi.mock('../pm/project-membership-manager.js', () => ({ getAccessibleProjectIds: vi.fn() }));
vi.mock('../workspace/jsonl-utils.js', () => ({ findJsonlFileForSession: vi.fn() }));
vi.mock('../auth/credential-store.js', () => ({ getConfigDir: vi.fn(async () => null) }));
vi.mock('../../engines/index.js', () => ({ getAllRunningSessionIds: vi.fn(() => []) }));
vi.mock('../../engines/pi/clone.js', () => ({ clonePiSessionFile: vi.fn() }));
vi.mock('../../engines/pi/rehydrate.js', () => ({ rehydratePiSessionFromMessages: vi.fn() }));
vi.mock('../../config.js', () => ({
  config: { defaultEngine: 'pi', piEnabled: true, claudeEnabled: true },
  normalizePiSessionModelId: (model: string | null) => model,
}));
vi.mock('./session-user-state.js', () => ({ subscribeSessionParticipant: mocks.subscribe }));
vi.mock('../harness/harness-store.js', () => ({ getOrPinSessionHarnessSnapshot: mocks.harness }));
import { createSession } from './session-manager.js';

function create(input: { userId?: number; projectId?: string | null; roomId?: string; label?: string; visibility?: 'private' | 'project' } = {}) {
  return createSession('Team conversation', '/synthetic/project', input.userId, input.projectId, 'pi', input.roomId,
    null, null, input.label, null, input.visibility ? { visibility: input.visibility } : undefined);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  mocks.queryOne.mockResolvedValue({ lifecycle_status: 'active', archived: 0 });
  mocks.execute.mockResolvedValue({});
  mocks.resolveContext.mockResolvedValue({ agentProjectId: 'agent', teamId: 'team', userId: 1 });
});
afterEach(() => vi.unstubAllEnvs());

function expectInsertedVisibility(visibility: string) {
  const insert = mocks.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO sessions'));
  expect(insert?.[1][10]).toBe(visibility);
}

describe('team Session creation defaults', () => {
  it('defaults team Agent conversations to private and persists that audience', async () => {
    const session = await create({ userId: 1, projectId: 'agent' });
    expect(session.visibility).toBe('private');
    expectInsertedVisibility('private');
    expect(mocks.resolveContext).toHaveBeenCalledWith({ userId: 1, agentProjectId: 'agent' });
    expect(mocks.resolveContext).toHaveBeenCalledTimes(1);
  });

  it.each(['0', '', 'true'])('retains legacy default and performs no additional lookup when flag=%s', async (flag) => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', flag);
    expect((await create({ userId: 1, projectId: 'agent' })).visibility).toBe('project');
    expectInsertedVisibility('project');
    expect(mocks.resolveContext).not.toHaveBeenCalled();
    // Existing lifecycle and creator-name reads remain; no team query is added.
    expect(mocks.queryOne).toHaveBeenCalledTimes(2);
    expect(mocks.queryOne.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('SELECT p.lifecycle_status'), expect.stringContaining('SELECT username'),
    ]);
  });

  it('retains private default with no project and does not resolve team context', async () => {
    expect((await create({ userId: 1 })).visibility).toBe('private');
    expect(mocks.resolveContext).not.toHaveBeenCalled();
    expect(mocks.queryOne).toHaveBeenCalledTimes(1);
    expect(mocks.queryOne).toHaveBeenCalledWith('SELECT username FROM users WHERE id = $1', [1]);
  });

  it('retains legacy project audience for confirmed teamless Agents', async () => {
    mocks.resolveContext.mockResolvedValue(null);
    expect((await create({ userId: 1, projectId: 'agent' })).visibility).toBe('project');
    expectInsertedVisibility('project');
  });

  it.each(['private', 'project'] as const)('preserves caller-authorized explicit %s without deriving audience grants', async (visibility) => {
    expect((await create({ userId: 1, projectId: 'agent', visibility })).visibility).toBe(visibility);
    expectInsertedVisibility(visibility);
    expect(mocks.resolveContext).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])('fails closed for invalid actor %s before any creation write', async (userId) => {
    await expect(create({ userId, projectId: 'agent' })).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it.each(['TEAM_WORKSPACE_ACCESS_DENIED', 'database unavailable'])('propagates %s without fallback or inserts, even with explicit audience', async (message) => {
    const error = new Error(message);
    mocks.resolveContext.mockRejectedValue(error);
    await expect(create({ userId: 1, projectId: 'agent', visibility: 'project' })).rejects.toBe(error);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it.each(['channel_agent', 'channel_ai'])('excludes room-bound %s creation from team resolution', async (label) => {
    expect((await create({ projectId: 'agent', roomId: 'room', label })).visibility).toBe('project');
    expect(mocks.resolveContext).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'channel_agent' }, { label: 'channel_ai' }, { roomId: 'room', label: 'spawned' }, { roomId: 'room' },
  ])('does not bypass team defaults with incomplete channel binding %j', async (binding) => {
    expect((await create({ userId: 1, projectId: 'agent', ...binding })).visibility).toBe('private');
    expect(mocks.resolveContext).toHaveBeenCalledTimes(1);
  });

  it('uses normalized channel labels consistently', async () => {
    const session = await create({ projectId: 'agent', roomId: 'room', label: ' channel_ai ' });
    expect(session.label).toBe('channel_ai');
    expect(mocks.resolveContext).not.toHaveBeenCalled();
  });

  it('still rejects a retired project before team lookup or creation writes', async () => {
    mocks.queryOne.mockResolvedValue({ lifecycle_status: 'retired', archived: 0 });
    await expect(create({ userId: 1, projectId: 'agent' })).rejects.toThrow('Agent is retired');
    expect(mocks.resolveContext).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
