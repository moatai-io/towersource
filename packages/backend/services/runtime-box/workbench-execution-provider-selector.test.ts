import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkbenchExecutionProvider } from '../execution/execution-broker.js';
import { assertWorkbenchDefaultWorkerSelected, isWorkbenchWorkstationProject, requiredWorkbenchWorkerCapabilities, resolveDefaultWorkbenchWorkerId, resolveRemoteWorkbenchBinding, resolveWorkbenchDeploymentId, selectPersistedWorkbenchExecutionProvider, selectWorkbenchExecutionProvider } from './workbench-execution-provider-selector.js';
import { clearWorkbenchWorkerRegistry, registerWorkbenchWorker, selectWorkbenchWorker, type WorkbenchWorkerView } from '../execution/worker/worker-registry.js';

const local = { kind: 'local-runtime' } as WorkbenchExecutionProvider;
const configured = {
  TOWER_REMOTE_WORKER_ID: 'worker-a',
  TOWER_REMOTE_WORKER_BASE_URL: 'https://worker.internal/',
  TOWER_REMOTE_WORKER_TOKEN: 'secret',
  TOWER_REMOTE_WORKER_PROJECT_IDS: 'p1,p2,p1',
};

describe('Workbench execution provider selector', () => {
  beforeEach(clearWorkbenchWorkerRegistry);

  it('keeps the dedicated dev backend on the development Worker deployment even when NODE_ENV is production', () => {
    expect(resolveWorkbenchDeploymentId({ PORT: '32355', NODE_ENV: 'production' })).toBe('development');
    expect(resolveWorkbenchDeploymentId({ PORT: '32355', NODE_ENV: 'production', TOWER_DEPLOYMENT_ID: 'canary' })).toBe('canary');
    expect(resolveWorkbenchDeploymentId({ PORT: '32364', NODE_ENV: 'production' })).toBe('production');
  });
  it('treats absent configuration as disabled and rejects partial configuration', () => {
    expect(resolveRemoteWorkbenchBinding({})).toBeNull();
    expect(() => resolveRemoteWorkbenchBinding({ TOWER_REMOTE_WORKER_ID: 'worker-a' })).toThrow('REMOTE_WORKER_CONFIG_INCOMPLETE');
    expect(() => resolveRemoteWorkbenchBinding({ ...configured, TOWER_REMOTE_WORKER_BASE_URL: 'file:///tmp/worker' })).toThrow('REMOTE_WORKER_CONFIG_INVALID');
  });

  it('normalizes one fixed Worker binding and exact Project allowlist', () => {
    expect(resolveRemoteWorkbenchBinding(configured)).toEqual({
      workerId: 'worker-a', baseUrl: 'https://worker.internal', token: 'secret', projectIds: ['p1', 'p2'],
    });
  });

  it('bootstraps the legacy binding and routes allowlisted foreground, durable Jobs, and Services remote', () => {
    expect(selectWorkbenchExecutionProvider({ projectId: 'p1', request: { command: 'npm test' }, env: configured, localProvider: local }).kind).toBe('remote-worker');
    expect(selectWorkbenchExecutionProvider({ projectId: 'p1', request: { command: 'pwd' }, env: configured, localProvider: local }).kind).toBe('remote-worker');
    expect(selectWorkbenchExecutionProvider({ projectId: 'p1', request: { command: 'python -m http.server 8000' }, env: configured, localProvider: local }).kind).toBe('remote-worker');
    expect(selectWorkbenchExecutionProvider({ projectId: 'other', request: { command: 'npm test' }, env: configured, localProvider: local })).toBe(local);
  });

  it('retires operator-plane Worker selection in favor of native Operator access', () => {
    expect(requiredWorkbenchWorkerCapabilities({ authorityMode: 'project', actorRole: 'member' })).toEqual(['job']);
    expect(() => requiredWorkbenchWorkerCapabilities({ authorityMode: 'operator-plane', actorRole: 'admin' })).toThrow('OPERATOR_WORKER_RETIRED');
    expect(() => requiredWorkbenchWorkerCapabilities({ authorityMode: 'operator-plane', actorRole: 'member' })).toThrow('OPERATOR_WORKER_RETIRED');
  });

  it.each(['member', 'operator', 'admin'])('does not inherit Worker capabilities from %s', actorRole => {
    expect(requiredWorkbenchWorkerCapabilities({ authorityMode: 'project', actorRole })).toEqual(['job']);
    expect(requiredWorkbenchWorkerCapabilities({ authorityMode: 'sandbox', actorRole })).toEqual(['job']);
    for (const env of [{}, configured]) {
      expect(() => selectWorkbenchExecutionProvider({
        projectId: 'p1', request: { command: 'pwd' }, authorityMode: 'operator-plane', actorRole, env, localProvider: local,
      })).toThrow('OPERATOR_WORKER_RETIRED');
    }
  });

  it('resolves a long-lived default Worker preference without making it execution authority', () => {
    expect(resolveDefaultWorkbenchWorkerId({ defaultWorkerId: ' worker-b ' })).toBe('worker-b');
    expect(resolveDefaultWorkbenchWorkerId({ env: { TOWER_WORKBENCH_DEFAULT_WORKER_ID: ' worker-c ' } })).toBe('worker-c');
    expect(resolveDefaultWorkbenchWorkerId({ defaultWorkerId: 'worker-b', env: { TOWER_WORKBENCH_DEFAULT_WORKER_ID: 'worker-c' } })).toBe('worker-b');
  });

  it('opts selected Projects into persistent Worker workspace mode without changing global defaults', () => {
    expect(isWorkbenchWorkstationProject({ projectId: 'p1', env: {} })).toBe(false);
    expect(isWorkbenchWorkstationProject({ projectId: 'p1', workstationMode: true, env: {} })).toBe(true);
    expect(isWorkbenchWorkstationProject({ projectId: 'p1', env: { TOWER_WORKBENCH_WORKSTATION_PROJECT_IDS: 'p2,p1' } })).toBe(true);
    expect(isWorkbenchWorkstationProject({ projectId: 'p3', env: { TOWER_WORKBENCH_WORKSTATION_PROJECT_IDS: 'p2,p1' } })).toBe(false);
    expect(isWorkbenchWorkstationProject({ projectId: 'p3', env: { TOWER_WORKBENCH_WORKSTATION_PROJECT_IDS: '*' } })).toBe(true);
  });

  it('keeps workstation Projects sticky to their default Worker but leaves pool scheduling flexible', () => {
    expect(() => assertWorkbenchDefaultWorkerSelected({
      projectId: 'p1', workstationMode: true, preferredWorkerId: 'tower-local-01', selectedWorkerId: 'iwinv-01',
    })).toThrow('DEFAULT_WORKER_UNAVAILABLE');
    expect(() => assertWorkbenchDefaultWorkerSelected({
      projectId: 'p1', workstationMode: true, preferredWorkerId: 'tower-local-01', selectedWorkerId: 'tower-local-01',
    })).not.toThrow();
    expect(() => assertWorkbenchDefaultWorkerSelected({
      projectId: 'p1', workstationMode: false, preferredWorkerId: 'tower-local-01', selectedWorkerId: 'iwinv-01',
    })).not.toThrow();
  });

  it('prefers the Project default Worker when multiple healthy Workers are eligible', () => {
    registerWorkbenchWorker({
      workerId: 'worker-a', baseUrl: 'https://worker-a.internal', capabilities: ['job'], projectIds: ['p1'],
      capacity: { cpuTotal: 8, memoryMbTotal: 16384, activeRuns: 0, maxRuns: 4 },
    });
    registerWorkbenchWorker({
      workerId: 'worker-b', baseUrl: 'https://worker-b.internal', capabilities: ['job'], projectIds: ['p1'],
      capacity: { cpuTotal: 8, memoryMbTotal: 16384, activeRuns: 3, maxRuns: 4 },
    });
    expect(selectWorkbenchWorker({ projectId: 'p1', requiredCapabilities: ['job'] }).workerId).toBe('worker-a');
    expect(selectWorkbenchWorker({ projectId: 'p1', requiredCapabilities: ['job'], preferredWorkerId: 'worker-b' }).workerId).toBe('worker-b');
    expect(selectWorkbenchWorker({ projectId: 'p1', requiredCapabilities: ['job'], preferredWorkerId: 'missing-worker' }).workerId).toBe('worker-a');
  });

  it('uses the scheduler-selected Worker when its authentication can be resolved', () => {
    const selected = {
      workerId: 'worker-b', baseUrl: 'https://worker-b.internal', capabilities: ['job'], projectIds: ['p1'],
      capacity: { cpuTotal: 8, memoryMbTotal: 16384, activeRuns: 0, maxRuns: 4 },
      registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'healthy',
    } satisfies WorkbenchWorkerView;
    const provider = selectWorkbenchExecutionProvider({
      projectId: 'p1', defaultWorkerId: 'worker-b', request: { command: 'npm test' }, env: configured, localProvider: local,
      selectWorker: selection => {
        expect(selection.preferredWorkerId).toBe('worker-b');
        return selected;
      }, resolveWorkerToken: workerId => workerId === 'worker-b' ? 'worker-b-token' : null,
    });
    expect(provider.kind).toBe('remote-worker');
  });

  it('allows a scheduler-selected Worker without legacy heartbeat Project scope for a resolved canonical environment', async () => {
    const selected = {
      workerId: 'tower-local-01', deploymentId: 'production', baseUrl: 'https://worker.internal', capabilities: ['job'], projectIds: [],
      capacity: { cpuTotal: 8, memoryMbTotal: 16384, activeRuns: 0, maxRuns: 4 },
      registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'healthy',
    } satisfies WorkbenchWorkerView;
    const executionContext = {
      projectId: 'p1', deploymentId: 'production', projectRoot: '/workspace/p1', logicalRoot: '/workspace' as const,
      actorUserId: 7, sessionId: 'session-a', userRole: 'member', projectWritable: true,
      environmentMode: 'canonical-project-workspace' as const, requiredCapabilities: ['job'],
    };
    expect((await selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', actorUserId: 7, sessionId: 'session-a', projectRoot: '/workspace/p1', request: { command: 'npm test' },
      env: { NODE_ENV: 'production' }, localProvider: local, workstationMode: false,
      deploymentId: 'production', executionContext,
      selectPersistedWorker: async selection => {
        expect(selection.preferredWorkerId).toBeUndefined();
        expect(selection.allowCanonicalProject).toBe(true);
        return selected;
      },
      resolvePersistedWorkerToken: async () => 'remote-token',
    })).kind).toBe('remote-worker');
  });

  it('allows a pinned Workstation to attempt dispatch when only heartbeat observation is stale', async () => {
    const selected = {
      workerId: 'tower-local-01', deploymentId: 'production', baseUrl: 'https://worker.internal', capabilities: ['job'], projectIds: ['p1'],
      capacity: { cpuTotal: 8, memoryMbTotal: 16384, activeRuns: 0, maxRuns: 4 },
      registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'stale',
    } satisfies WorkbenchWorkerView;
    expect((await selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', actorUserId: 7, projectRoot: '/workspace/p1', request: { command: 'npm test' },
      env: { NODE_ENV: 'production' }, localProvider: local, workstationMode: true,
      deploymentId: 'production', defaultWorkerId: 'tower-local-01',
      selectPersistedWorker: async selection => {
        expect(selection.allowStalePreferredWorker).toBe(true);
        return selected;
      },
      resolvePersistedWorkerToken: async () => 'remote-token',
    })).kind).toBe('remote-worker');
  });

  it('uses resolved legacy workspace identity, not caller flags alone, for stale heartbeat fallback', async () => {
    const selected = {
      workerId: 'tower-local-01', deploymentId: 'production', baseUrl: 'https://worker.internal', capabilities: ['job'], projectIds: ['p1'],
      capacity: { cpuTotal: 8, memoryMbTotal: 16384, activeRuns: 0, maxRuns: 4 },
      registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'stale',
    } satisfies WorkbenchWorkerView;
    const executionContext = {
      projectId: 'p1', deploymentId: 'production', projectRoot: '/workspace/p1', logicalRoot: '/workspace' as const,
      actorUserId: 7, sessionId: 'session-a', userRole: 'member', projectWritable: true,
      environmentMode: 'legacy-worker-workspace' as const, preferredExecutorId: 'tower-local-01', requiredCapabilities: ['job'],
    };
    expect((await selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', actorUserId: 7, sessionId: 'session-a', projectRoot: '/workspace/p1', request: { command: 'npm test' },
      env: { NODE_ENV: 'production' }, localProvider: local, workstationMode: false,
      deploymentId: 'production', defaultWorkerId: 'tower-local-01', executionContext,
      selectPersistedWorker: async selection => {
        expect(selection.allowStalePreferredWorker).toBe(true);
        return selected;
      },
      resolvePersistedWorkerToken: async () => 'remote-token',
    })).kind).toBe('remote-worker');
  });

  it('keeps heartbeat as a hard eligibility signal for unpinned pooled Workers', async () => {
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' }, env: { NODE_ENV: 'production' }, localProvider: local,
      runtimeBoxCompatibilityEnabled: false,
      selectPersistedWorker: async selection => {
        expect(selection.allowStalePreferredWorker).toBe(false);
        throw new Error('NO_ELIGIBLE_WORKER');
      },
    })).rejects.toThrow('PROJECT_EXECUTION_PLANE_UNAVAILABLE: Project p1 cannot run because no eligible pooled Worker is currently healthy and available; Runtime Box compatibility is disabled');
  });

  it('preserves pooled Worker capacity exhaustion in the unavailable error', async () => {
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' }, env: { NODE_ENV: 'production' }, localProvider: local,
      runtimeBoxCompatibilityEnabled: false,
      selectPersistedWorker: async () => {
        throw new Error('WORKER_BUSY: all eligible Workers are at capacity');
      },
    })).rejects.toThrow('PROJECT_EXECUTION_PLANE_UNAVAILABLE: Project p1 cannot run because eligible pooled Worker capacity is currently exhausted (WORKER_BUSY: all eligible Workers are at capacity); Runtime Box compatibility is disabled');
  });

  it('rejects a different scheduler fallback for workstation Projects', async () => {
    const selected = {
      workerId: 'iwinv-01', baseUrl: 'https://remote.internal', capabilities: ['job'], projectIds: ['p1'],
      capacity: { cpuTotal: 2, memoryMbTotal: 2048, activeRuns: 0, maxRuns: 1 },
      registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'healthy',
    } satisfies WorkbenchWorkerView;
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' }, env: configured, localProvider: local,
      workstationMode: true, defaultWorkerId: 'tower-local-01',
      selectPersistedWorker: async () => selected,
      resolvePersistedWorkerToken: async () => 'remote-token',
    })).rejects.toThrow('DEFAULT_WORKER_UNAVAILABLE');
  });

  it('prefers a persisted healthy Worker and binds only when its transport authentication resolves', async () => {
    const selected = {
      workerId: 'worker-b', baseUrl: 'https://worker-b.internal', capabilities: ['job'], projectIds: ['p1'],
      capacity: { cpuTotal: 8, memoryMbTotal: 16384, activeRuns: 0, maxRuns: 4 },
      registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'healthy',
    } satisfies WorkbenchWorkerView;
    expect((await selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' }, env: configured, localProvider: local,
      defaultWorkerId: 'worker-b',
      selectPersistedWorker: async selection => {
        expect(selection.preferredWorkerId).toBe('worker-b');
        return selected;
      },
      resolvePersistedWorkerToken: async workerId => workerId === 'worker-b' ? 'worker-b-token' : null,
    })).kind).toBe('remote-worker');
    expect((await selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'python -m http.server 8000' }, env: configured, localProvider: local,
      defaultWorkerId: 'worker-b',
      selectPersistedWorker: async selection => {
        expect(selection.preferredWorkerId).toBe('worker-b');
        return selected;
      },
      resolvePersistedWorkerToken: async workerId => workerId === 'worker-b' ? 'worker-b-token' : null,
    })).kind).toBe('remote-worker');
    expect(await selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' }, env: configured, localProvider: local,
      selectPersistedWorker: async () => selected, resolvePersistedWorkerToken: async () => null,
    })).toBe(local);
  });

  it('keeps unbound production Projects on the local Runtime Box compatibility provider by default', async () => {
    expect(await selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'node -v' }, env: { NODE_ENV: 'production' }, localProvider: local,
      selectPersistedWorker: async selection => {
        expect(selection.deploymentId).toBe('production');
        throw new Error('NO_ELIGIBLE_WORKER');
      },
    })).toBe(local);
  });

  it('fails closed for unbound Projects when Runtime Box compatibility is disabled', async () => {
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'node -v' }, env: { NODE_ENV: 'production' }, localProvider: local,
      runtimeBoxCompatibilityEnabled: false,
      selectPersistedWorker: async () => { throw new Error('NO_ELIGIBLE_WORKER'); },
    })).rejects.toThrow('PROJECT_EXECUTION_PLANE_UNAVAILABLE');
  });

  it.each([
    ['WORKSTATION_WORKER_BUSY: tower-prod-local-01; retry after the current command finishes', 'WORKSTATION_WORKER_BUSY'],
    ['WORKSTATION_WORKER_HEARTBEAT_STALE: tower-prod-local-01; operator action may be required', 'WORKSTATION_WORKER_HEARTBEAT_STALE'],
    ['WORKSTATION_WORKER_DRAINING: tower-prod-local-01; maintenance', 'WORKSTATION_WORKER_DRAINING'],
    ['WORKSTATION_WORKER_CAPACITY_CONFIG_INVALID: tower-prod-local-01; operator action is required', 'WORKSTATION_WORKER_CAPACITY_CONFIG_INVALID'],
  ])('preserves actionable Workstation failure reasons instead of switching to Runtime Box', async (sourceError, expectedCode) => {
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'node -v' }, env: { NODE_ENV: 'production' }, localProvider: local,
      workstationMode: true, defaultWorkerId: 'tower-prod-local-01',
      selectPersistedWorker: async () => { throw new Error(sourceError); },
    })).rejects.toThrow(expectedCode);
  });

  it('maps unpinned capacity exhaustion to a retryable Workstation busy error', async () => {
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'node -v' }, env: { NODE_ENV: 'production' }, localProvider: local,
      workstationMode: true, defaultWorkerId: 'tower-prod-local-01',
      selectPersistedWorker: async () => { throw new Error('WORKER_BUSY: no Worker has enough free capacity'); },
    })).rejects.toThrow('WORKSTATION_WORKER_BUSY');
  });

  it('reports selected Worker transport authorization failure as operator action, not recovery wait', async () => {
    const selected = {
      workerId: 'tower-prod-local-01', baseUrl: 'http://127.0.0.1:43325', capabilities: ['job'], projectIds: ['p1'],
      capacity: { cpuTotal: 4, memoryMbTotal: 8192, activeRuns: 0, maxRuns: 4 },
      registeredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), draining: false, status: 'healthy',
    } satisfies WorkbenchWorkerView;
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'node -v' }, env: { NODE_ENV: 'production' }, localProvider: local,
      workstationMode: true, defaultWorkerId: 'tower-prod-local-01',
      selectPersistedWorker: async () => selected, resolvePersistedWorkerToken: async () => null,
    })).rejects.toThrow('WORKSTATION_WORKER_AUTH_UNAVAILABLE');
  });

  it('falls back to the legacy binding only when the durable pool has no eligible Worker', async () => {
    expect((await selectPersistedWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' }, env: configured, localProvider: local,
      selectPersistedWorker: async () => { throw new Error('NO_ELIGIBLE_WORKER'); },
    })).kind).toBe('remote-worker');
    expect(await selectPersistedWorkbenchExecutionProvider({
      projectId: 'other', request: { command: 'npm test' }, env: configured, localProvider: local,
      selectPersistedWorker: async () => { throw new Error('NO_ELIGIBLE_WORKER'); },
    })).toBe(local);
  });

  it('skips the migration rsync bridge only for opt-in Workstation Projects', () => {
    const selected = {
      workerId: 'worker-a', baseUrl: 'https://worker-a.internal', capabilities: ['job'], projectIds: ['p1'],
      capacity: { cpuTotal: 8, memoryMbTotal: 16384, activeRuns: 0, maxRuns: 4 },
      registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'healthy',
    } satisfies WorkbenchWorkerView;
    const incompleteRsync = { ...configured, TOWER_REMOTE_WORKER_RSYNC_REMOTE: 'root@example' };
    expect(() => selectWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' }, env: incompleteRsync, localProvider: local,
      selectWorker: () => selected, resolveWorkerToken: () => 'worker-token',
    })).toThrow('REMOTE_WORKSPACE_CONFIG_INCOMPLETE');
    expect(selectWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' },
      env: { ...incompleteRsync, TOWER_WORKBENCH_WORKSTATION_PROJECT_IDS: 'p1' }, localProvider: local,
      selectWorker: () => selected, resolveWorkerToken: () => 'worker-token',
    }).kind).toBe('remote-worker');
  });

  it('fails closed to Local Runtime when scheduler selection or selected Worker authentication is unavailable', () => {
    expect(selectWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' }, env: configured, localProvider: local,
      selectWorker: () => { throw new Error('NO_ELIGIBLE_WORKER'); },
    })).toBe(local);
    expect(selectWorkbenchExecutionProvider({
      projectId: 'p1', request: { command: 'npm test' }, env: configured, localProvider: local,
      selectWorker: () => ({
        workerId: 'worker-b', baseUrl: 'https://worker-b.internal', capabilities: ['job'], projectIds: ['p1'],
        capacity: { cpuTotal: 8, memoryMbTotal: 16384, activeRuns: 0, maxRuns: 4 },
        registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'healthy',
      }), resolveWorkerToken: () => null,
    })).toBe(local);
  });
});
