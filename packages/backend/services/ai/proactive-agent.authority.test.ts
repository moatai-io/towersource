import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  account: vi.fn(), queryOne: vi.fn(), allowedPath: vi.fn(), accessiblePaths: vi.fn(), presetReady: vi.fn(),
  sendAccess: vi.fn(), createAccess: vi.fn(), pathAccess: vi.fn(), resolveRoot: vi.fn(),
  getSession: vi.fn(), createSession: vi.fn(), updateSession: vi.fn(), claim: vi.fn(),
  save: vi.fn(), notify: vi.fn(), running: vi.fn(), getEngine: vi.fn(), run: vi.fn(),
}));
vi.mock('../../config.js', () => ({
  config: { workspaceRoot: '/workspace', defaultEngine: 'pi', piEnabled: true, claudeEnabled: true },
  getModelDefaults: () => ({ session: 'preset/core' }),
}));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.queryOne }));
vi.mock('../auth/auth.js', () => ({ getUserAuthState: mocks.account, getUserAllowedPath: mocks.allowedPath }));
vi.mock('../pm/project-access.js', () => ({
  canSendSessionMessage: mocks.sendAccess, canCreateInProject: mocks.createAccess,
  getUserAccessiblePaths: mocks.accessiblePaths, isPathAccessible: mocks.pathAccess,
  resolveSessionProjectRoot: mocks.resolveRoot,
}));
vi.mock('../session/session-manager.js', () => ({
  getSession: mocks.getSession, createSession: mocks.createSession, updateSession: mocks.updateSession,
  getEngineSessionId: (session: any) => session.engineSessionId, claimEngineSessionId: mocks.claim,
}));
vi.mock('../message-store.js', () => ({ saveMessage: mocks.save }));
vi.mock('../notification-hub.js', () => ({ notify: mocks.notify }));
vi.mock('../../engines/index.js', () => ({ getEngine: mocks.getEngine, getAllRunningSessionIds: mocks.running }));
vi.mock('../system-prompt-fragments.js', () => ({ selectSystemPromptFragmentsForMessage: () => ['test-fragment'] }));
vi.mock('../model-policy/session-alias.js', () => ({ isPiPresetMappingReady: mocks.presetReady }));
vi.mock('../ai-usage/usage-ledger.js', () => ({ recordPiUsageEvent: vi.fn() }));
vi.mock('./litellm-model-catalog.js', () => ({ isModelPolicyId: () => false }));

import { fireProactive, type ProactiveTemplate } from './proactive-agent.js';

const template: ProactiveTemplate = { id: 'job', name: 'Follow-up', prompt: 'Check the project.', projectId: 'project-1' };
const target = {
  id: 'target', projectId: 'project-1', cwd: '/workspace/projects/demo/work',
  engine: 'pi', engineSessionId: 'native-target', modelUsed: 'preset/core', configDir: '/account/config',
};
let userId = 0;

beforeEach(() => {
  vi.resetAllMocks();
  // Avoid the module's per-user daily successful-run counter coupling tests.
  userId++;
  mocks.account.mockResolvedValue({ role: 'member', disabled: false, approvalStatus: 'active' });
  mocks.queryOne.mockImplementation(async (sql: string) => sql.includes('FROM users')
    ? { username: 'scheduled-user' } : { root_path: '/workspace/projects/demo' });
  mocks.presetReady.mockReturnValue(true);
  mocks.allowedPath.mockResolvedValue('/workspace/projects');
  mocks.accessiblePaths.mockResolvedValue(['/workspace/projects/demo']);
  mocks.sendAccess.mockResolvedValue({ allowed: true });
  mocks.createAccess.mockResolvedValue({ allowed: true });
  mocks.pathAccess.mockResolvedValue(true);
  mocks.resolveRoot.mockReturnValue(undefined);
  mocks.getSession.mockResolvedValue({ ...target });
  mocks.createSession.mockResolvedValue({ id: 'new-session', configDir: '/new/config' });
  mocks.running.mockReturnValue([]);
  mocks.run.mockImplementation(async function* () {
    yield { type: 'assistant', content: [{ type: 'text', text: 'Done.' }] };
    yield { type: 'engine_done' };
  });
  mocks.getEngine.mockResolvedValue({ run: mocks.run });
});

function inject(overrides: Partial<ProactiveTemplate> = {}) {
  return fireProactive(userId, { ...template, ...overrides }, undefined,
    { targetSessionId: 'target', suppressCompletionNotification: true });
}
function expectNoWrites() {
  expect(mocks.createSession).not.toHaveBeenCalled();
  expect(mocks.updateSession).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
}

describe('proactive current-account and target Session authority', () => {
  it.each(['member', 'operator', 'admin'])('uses current %s authority and target execution context', async role => {
    mocks.account.mockResolvedValue({ role, disabled: false, approvalStatus: 'active' });
    mocks.accessiblePaths.mockResolvedValue(role === 'admin' ? null : ['/workspace/projects/demo']);
    await inject();
    expect(mocks.sendAccess).toHaveBeenCalledWith('target', userId, role);
    expect(mocks.accessiblePaths).toHaveBeenCalledWith(userId, role);
    expect(mocks.pathAccess).toHaveBeenCalledWith(target.cwd, userId, role);
    expect(mocks.run).toHaveBeenCalledWith('target', expect.any(String), expect.objectContaining({
      cwd: target.cwd, projectId: 'project-1', sessionProjectRoot: '/workspace/projects/demo',
      userId, username: 'scheduled-user', userRole: role, allowedPath: '/workspace/projects',
      accessiblePaths: role === 'admin' ? null : ['/workspace/projects/demo'],
      engineSessionId: 'native-target', configDir: '/account/config', model: 'preset/core',
    }), expect.any(Object));
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('inherits project and stored model from target when template omits them', async () => {
    mocks.getSession.mockResolvedValue({ ...target, modelUsed: 'router/target-model' });
    await inject({ projectId: undefined });
    expect(mocks.run.mock.calls[0][2]).toMatchObject({ projectId: 'project-1', model: 'router/target-model' });
  });

  it('uses the target Claude engine instead of VM default Pi', async () => {
    mocks.getSession.mockResolvedValue({ ...target, engine: 'claude', modelUsed: 'claude-sonnet-4-6' });
    await inject();
    expect(mocks.getEngine).toHaveBeenCalledWith('claude');
    expect(mocks.run.mock.calls[0][2]).toMatchObject({ model: 'claude-sonnet-4-6', engineSessionId: 'native-target' });
  });

  it.each([
    null,
    { role: 'member', disabled: true, approvalStatus: 'active' },
    { role: 'member', disabled: false, approvalStatus: 'pending' },
    { role: 'invalid', disabled: false, approvalStatus: 'active' },
  ])('rejects inactive/missing/invalid account before any side effect (%j)', async account => {
    mocks.account.mockResolvedValue(account);
    await expect(inject()).rejects.toThrow('active account');
    expectNoWrites();
  });

  it('rejects a removed run-as user before any side effect', async () => {
    mocks.queryOne.mockResolvedValue(null);
    await expect(inject()).rejects.toThrow('user not found');
    expectNoWrites();
  });

  it.each(['guest', 'viewer'])('uses existing Session-send policy to reject read-only %s', async role => {
    mocks.account.mockResolvedValue({ role, disabled: false, approvalStatus: 'active' });
    mocks.sendAccess.mockResolvedValue({ allowed: false, message: 'Agent use requires a writable role' });
    await expect(inject()).rejects.toThrow('writable role');
    expect(mocks.sendAccess).toHaveBeenCalledWith('target', userId, role);
    expectNoWrites();
  });

  it('rejects session visibility without send authority', async () => {
    mocks.sendAccess.mockResolvedValue({ allowed: false, message: 'Session ownership required' });
    await expect(inject()).rejects.toThrow('Session ownership required');
    expect(mocks.getSession).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('rejects explicit project mismatch even for an admin', async () => {
    mocks.account.mockResolvedValue({ role: 'admin', disabled: false, approvalStatus: 'active' });
    await expect(inject({ projectId: 'other-project' })).rejects.toThrow('project mismatch');
    expectNoWrites();
  });

  it.each(['/workspace/projects/other', '/workspace/projects/demo-sibling', 'relative/path'])('rejects mismatched or invalid target cwd %s', async cwd => {
    mocks.getSession.mockResolvedValue({ ...target, cwd });
    await expect(inject()).rejects.toThrow(/cwd/);
    expectNoWrites();
  });

  it('rejects target cwd denied by existing filesystem access helper', async () => {
    mocks.pathAccess.mockResolvedValue(false);
    await expect(inject()).rejects.toThrow('cwd access denied');
    expectNoWrites();
  });

  it('fails closed when project root is unavailable', async () => {
    mocks.queryOne.mockImplementation(async (sql: string) => sql.includes('FROM users') ? { username: 'user' } : null);
    await expect(inject()).rejects.toThrow('canonical root');
    expectNoWrites();
  });

  it('does not widen access when accessible-path lookup fails', async () => {
    mocks.accessiblePaths.mockRejectedValue(new Error('access lookup failed'));
    await expect(inject()).rejects.toThrow('access lookup failed');
    expectNoWrites();
  });

  it.each([
    ['pi', 'claude-sonnet-4-6'],
    ['claude', 'router/model'],
  ])('rejects explicit model incompatible with target engine %s', async (engine, model) => {
    mocks.getSession.mockResolvedValue({ ...target, engine });
    await expect(inject({ model })).rejects.toThrow('model does not match');
    expectNoWrites();
  });

  it('rejects unavailable preset mapping before writing a message or creating a Session', async () => {
    mocks.presetReady.mockReturnValue(false);
    await expect(inject()).rejects.toThrow('MODEL_PRESET_UNAVAILABLE');
    expectNoWrites();
  });

  it('rejects missing target Session', async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(inject()).rejects.toThrow('Target session not found');
    expectNoWrites();
  });

  it('rejects streaming target Session', async () => {
    mocks.running.mockReturnValue(['target']);
    await expect(inject()).rejects.toThrow('currently streaming');
    expectNoWrites();
  });

  it('creates new sessions at canonical registered root with current user authority', async () => {
    await fireProactive(userId, template, undefined, { suppressCompletionNotification: true });
    expect(mocks.createAccess).toHaveBeenCalledWith('project-1', userId, 'member');
    expect(mocks.createSession).toHaveBeenCalledWith('💬 Follow-up', '/workspace/projects/demo', userId,
      'project-1', 'pi', undefined, undefined, undefined, 'proactive', 'preset/core');
    expect(mocks.run.mock.calls[0][2]).toMatchObject({ cwd: '/workspace/projects/demo', userRole: 'member' });
  });

  it('rejects new-session engine/model mismatch before creating a Session', async () => {
    await expect(fireProactive(userId, { ...template, model: 'claude-sonnet-4-6' })).rejects.toThrow('model does not match');
    expectNoWrites();
  });

  it('rejects new-session Project access before creating a Session', async () => {
    mocks.createAccess.mockResolvedValue({ allowed: false, message: 'Project access denied' });
    await expect(fireProactive(userId, template)).rejects.toThrow('Project access denied');
    expectNoWrites();
  });
});
