import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchExecutionProvider, WorkbenchExecutionRequest } from '../execution/execution-broker.js';
import { planWorkbenchExecution } from '../execution/execution-broker.js';
import { resolveProjectExecutionContext } from './project-execution-context.js';
import { selectPersistedWorkbenchExecutionProvider } from '../runtime-box/workbench-execution-provider-selector.js';
import type { WorkbenchWorkerView } from '../execution/worker/worker-registry.js';

const projectId = 'new-project';
const projectRoot = '/srv/workspace/projects/new-project';
const deploymentId = 'production';
const local = { kind: 'local-runtime' } as WorkbenchExecutionProvider;
const unscopedWorker = {
  workerId: 'shared-worker-01', deploymentId, baseUrl: 'https://worker.internal', capabilities: ['job'], projectIds: [],
  capacity: { cpuTotal: 8, memoryMbTotal: 16_384, activeRuns: 0, maxRuns: 4 },
  registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'healthy',
} satisfies WorkbenchWorkerView;

async function canonicalContext() {
  return resolveProjectExecutionContext({
    projectId, actorUserId: 7, sessionId: 'session-a', deploymentId,
    requiredCapabilities: ['job'], expectedProjectRoot: projectRoot,
  }, {
    requireAccess: vi.fn().mockResolvedValue({ userRole: 'member', projectMember: true, projectOwner: false, projectWritable: true }),
    readProject: vi.fn().mockResolvedValue({ rootPath: projectRoot, lifecycleStatus: 'active', archived: false }),
    readLegacyPlacement: vi.fn().mockResolvedValue(undefined),
    readWorkspaceAuthorities: vi.fn().mockResolvedValue([{ project_id: projectId, deployment_id: deploymentId, storage_kind: 'host', worker_id: null, state: 'ready', version: 1 }]),
    realpath: vi.fn(async value => value),
  });
}

async function select(request: WorkbenchExecutionRequest) {
  const executionContext = await canonicalContext();
  const provider = await selectPersistedWorkbenchExecutionProvider({
    projectId, actorUserId: 7, sessionId: 'session-a', projectRoot, deploymentId,
    executionContext, request, env: { NODE_ENV: 'production' }, localProvider: local,
    runtimeBoxCompatibilityEnabled: false,
    selectPersistedWorker: async selection => {
      expect(selection).toMatchObject({ projectId, deploymentId, allowCanonicalProject: true });
      expect(selection.preferredWorkerId).toBeUndefined();
      return unscopedWorker;
    },
    resolvePersistedWorkerToken: async workerId => workerId === unscopedWorker.workerId ? 'transport-token' : null,
  });
  return { executionContext, provider, plan: planWorkbenchExecution(request, provider.kind) };
}

describe('Worker-lite canonical Project execution canary', () => {
  it.each([
    ['foreground', { command: 'node -v', lifecycle: 'foreground' }],
    ['job', { command: 'npm test', lifecycle: 'job' }],
    ['service', { command: 'node server.js', lifecycle: 'service', service: { name: 'web', port: 3000 } }],
  ] as const)('selects an unscoped Worker for %s without creating a Project-to-Worker authority binding', async (lifecycle, request) => {
    const result = await select(request);
    expect(result.executionContext).toMatchObject({ environmentMode: 'canonical-project-workspace' });
    expect(result.executionContext).not.toHaveProperty('preferredExecutorId');
    expect(result.provider.kind).toBe('remote-worker');
    expect(result.plan.lifecycle).toBe(lifecycle);
  });

  it('keeps legacy Worker storage pinned and rejects a different scheduler Worker', async () => {
    const executionContext = await resolveProjectExecutionContext({
      projectId, actorUserId: 7, sessionId: 'session-a', deploymentId,
      requiredCapabilities: ['job'], expectedProjectRoot: projectRoot,
    }, {
      requireAccess: vi.fn().mockResolvedValue({ userRole: 'member', projectMember: true, projectOwner: false, projectWritable: true }),
      readProject: vi.fn().mockResolvedValue({ rootPath: projectRoot, lifecycleStatus: 'active', archived: false }),
      readLegacyPlacement: vi.fn().mockResolvedValue({ projectId, deploymentId, defaultWorkerId: 'legacy-worker-01', workstationMode: true, authorityMode: 'project' }),
      readWorkspaceAuthorities: vi.fn().mockResolvedValue([{ project_id: projectId, deployment_id: deploymentId, storage_kind: 'worker', worker_id: 'legacy-worker-01', state: 'ready', version: 1 }]),
      realpath: vi.fn(async value => value),
    });
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId, actorUserId: 7, sessionId: 'session-a', projectRoot, deploymentId,
      executionContext, workstationMode: true, defaultWorkerId: executionContext.preferredExecutorId,
      request: { command: 'npm test', lifecycle: 'job' }, env: { NODE_ENV: 'production' }, localProvider: local,
      runtimeBoxCompatibilityEnabled: false,
      selectPersistedWorker: async () => unscopedWorker,
      resolvePersistedWorkerToken: async () => 'transport-token',
    })).rejects.toThrow('DEFAULT_WORKER_UNAVAILABLE');
  });

  it('fails closed instead of using Local Runtime when no authorized Worker exists', async () => {
    const executionContext = await canonicalContext();
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId, actorUserId: 7, sessionId: 'session-a', projectRoot, deploymentId,
      executionContext, request: { command: 'node -v' }, env: { NODE_ENV: 'production' }, localProvider: local,
      runtimeBoxCompatibilityEnabled: false,
      selectPersistedWorker: async () => { throw new Error('NO_ELIGIBLE_WORKER'); },
    })).rejects.toThrow('PROJECT_EXECUTION_PLANE_UNAVAILABLE');
  });
});
