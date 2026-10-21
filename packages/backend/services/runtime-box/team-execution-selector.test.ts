import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveTeamAgentContext } from '../agent-workspaces/team-context.js';
import { createLocalWorkbenchExecutionProvider } from './workbench-local-execution-provider.js';
import { createRemoteWorkbenchExecutionProvider } from './workbench-remote-execution-provider.js';
import { createRemoteWorkbenchHttpTransport } from '../execution/worker/worker-http-transport.js';
import { resolveWorkbenchWorkerTransportToken } from '../execution/worker/worker-transport-credentials.js';
import { selectPersistedWorkbenchExecutionProvider as select, selectWorkbenchExecutionProvider as selectLegacy } from './workbench-execution-provider-selector.js';
vi.mock('../agent-workspaces/team-context.js', () => ({ resolveTeamAgentContext: vi.fn() }));
vi.mock('./workbench-local-execution-provider.js', () => ({ createLocalWorkbenchExecutionProvider: vi.fn() }));
vi.mock('./workbench-remote-execution-provider.js', () => ({ createRemoteWorkbenchExecutionProvider: vi.fn() }));
vi.mock('../execution/worker/worker-http-transport.js', () => ({ createRemoteWorkbenchHttpTransport: vi.fn() }));
vi.mock('../execution/worker/worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken: vi.fn() }));
const local = { kind: 'local-runtime' } as any;
const remote = { kind: 'remote-worker' } as any;
const worker = { workerId: 'worker-a', baseUrl: 'https://worker.example.com', projectIds: ['a'], capabilities: ['job'] } as any;
const input = { projectId: 'a', actorUserId: 1, projectRoot: '/workspace/a', deploymentId: 'test',
  sessionId: 'session-a', request: { command: 'true', lifecycle: 'job' as const } };
let selectWorker: ReturnType<typeof vi.fn>;
let resolveToken: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  vi.stubEnv('TOWER_WORKBENCH_WORKSTATION_PROJECT_IDS', 'p1');
  vi.mocked(resolveTeamAgentContext).mockResolvedValue({ agentProjectId: 'a', userId: 1, teamId: 'team-a' });
  vi.mocked(createLocalWorkbenchExecutionProvider).mockReturnValue(local);
  vi.mocked(createRemoteWorkbenchExecutionProvider).mockReturnValue(remote);
  vi.mocked(createRemoteWorkbenchHttpTransport).mockReturnValue({ workerId: 'worker-a' } as any);
  selectWorker = vi.fn().mockResolvedValue(worker); resolveToken = vi.fn().mockResolvedValue('fixture-token');
});
afterEach(() => vi.unstubAllEnvs());
const request = (extra = {}) => select({ ...input, selectPersistedWorker: selectWorker, resolvePersistedWorkerToken: resolveToken, ...extra });
function expectNoProviderOrCredentials() {
  expect(createLocalWorkbenchExecutionProvider).not.toHaveBeenCalled();
  expect(createRemoteWorkbenchExecutionProvider).not.toHaveBeenCalled();
  expect(createRemoteWorkbenchHttpTransport).not.toHaveBeenCalled();
  expect(selectWorker).not.toHaveBeenCalled();
  expect(resolveToken).not.toHaveBeenCalled();
  expect(resolveWorkbenchWorkerTransportToken).not.toHaveBeenCalled();
}
it.each(['foreground', 'job', 'service'] as const)('rejects a team before any %s provider/credential selection', async lifecycle => {
  await expect(request({ request: { command: 'true', lifecycle }, runtimeBoxCompatibilityEnabled: true })).rejects.toThrow('TEAM_EXECUTOR_NOT_READY');
  expect(resolveTeamAgentContext).toHaveBeenCalledWith({ userId: 1, agentProjectId: 'a' });
  expectNoProviderOrCredentials();
});
it('does not trust caller env to opt out of a process-enabled team guard', async () => {
  await expect(request({ env: { TOWER_TEAM_WORKSPACES_ENABLED: '0' } })).rejects.toThrow('TEAM_EXECUTOR_NOT_READY');
  expectNoProviderOrCredentials();
});
it('does not treat a supplied executionContext as current team admission', async () => {
  await expect(request({ executionContext: { ...input, environmentMode: 'canonical-project-workspace', logicalRoot: '/workspace', requiredCapabilities: ['job'], userRole: 'member', projectWritable: true } })).rejects.toThrow('TEAM_EXECUTOR_NOT_READY');
  expectNoProviderOrCredentials();
});
it.each(['TEAM_WORKSPACE_ACCESS_DENIED', 'TEAM_WORKSPACE_CONTEXT_REQUIRED', 'DB_UNAVAILABLE', 'WORKER_NOT_AVAILABLE: pretend lookup error'])('propagates %s before fallback/provider lookup', async message => {
  const error = new Error(message); vi.mocked(resolveTeamAgentContext).mockRejectedValue(error);
  await expect(request({ runtimeBoxCompatibilityEnabled: true, env: {} })).rejects.toBe(error);
  expectNoProviderOrCredentials();
});
it.each([undefined, '0', 'true'])('does not query team DB when the process switch is not exact 1 (%s)', async enabled => {
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', enabled);
  expect(await request()).toBe(remote);
  expect(resolveTeamAgentContext).not.toHaveBeenCalled();
  expect(selectWorker).toHaveBeenCalledOnce(); expect(resolveToken).toHaveBeenCalledOnce();
});
it('does not enable the team policy using caller env when process policy is off', async () => {
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '0');
  expect(await request({ projectRoot: undefined, env: { TOWER_TEAM_WORKSPACES_ENABLED: '1' } })).toBe(remote);
  expect(resolveTeamAgentContext).not.toHaveBeenCalled();
});
it('fails closed on a missing actor before provider selection when team policy is enabled', async () => {
  vi.mocked(resolveTeamAgentContext).mockRejectedValue(new Error('TEAM_WORKSPACE_CONTEXT_REQUIRED'));
  await expect(request({ actorUserId: undefined })).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  expect(resolveTeamAgentContext).toHaveBeenCalledWith({ userId: undefined, agentProjectId: 'a' });
  expectNoProviderOrCredentials();
});
it('preserves explicitly teamless remote selection', async () => {
  vi.mocked(resolveTeamAgentContext).mockResolvedValue(null);
  expect(await request()).toBe(remote);
  expect(selectWorker).toHaveBeenCalledOnce(); expect(resolveToken).toHaveBeenCalledOnce();
});
it('preserves explicitly teamless local compatibility only after current context admission', async () => {
  vi.mocked(resolveTeamAgentContext).mockResolvedValue(null);
  selectWorker.mockRejectedValue(new Error('NO_ELIGIBLE_WORKER'));
  expect(await request({ runtimeBoxCompatibilityEnabled: true, env: {} })).toBe(local);
  expect(resolveTeamAgentContext).toHaveBeenCalledOnce();
  expect(resolveToken).not.toHaveBeenCalled();
});
it('does not restore host fallback for a teamless caller when compatibility is disabled', async () => {
  vi.mocked(resolveTeamAgentContext).mockResolvedValue(null);
  selectWorker.mockRejectedValue(new Error('NO_ELIGIBLE_WORKER'));
  await expect(request({ runtimeBoxCompatibilityEnabled: false, env: {} })).rejects.toThrow('PROJECT_EXECUTION_PLANE_UNAVAILABLE');
  expect(resolveToken).not.toHaveBeenCalled();
});
it('rejects direct synchronous selection when enabled because it cannot verify current team context', () => {
  expect(() => selectLegacy({ ...input, env: {} })).toThrow('TEAM_EXECUTOR_NOT_READY');
  expectNoProviderOrCredentials();
  expect(resolveTeamAgentContext).not.toHaveBeenCalled();
});
it('preserves legacy synchronous selection when the policy is off', () => {
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '0');
  expect(selectLegacy({ ...input, localProvider: local, env: {} })).toBe(local);
  expect(resolveTeamAgentContext).not.toHaveBeenCalled();
});
