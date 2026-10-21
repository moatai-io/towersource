import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { requestProjectWorkerAssignment } from './workbench-project-worker-assignment.js';
import { requestAutomaticProjectWorkerAssignment } from './workbench-project-worker-auto-request.js';

vi.mock('../../config.js', () => ({ config: { workspaceRoot: '/workspace' } }));
vi.mock('../execution/worker/worker-repository.js', () => ({ getPersistedWorkbenchWorker: vi.fn() }));
vi.mock('./workbench-project-worker-assignment.js', () => ({ requestProjectWorkerAssignment: vi.fn() }));

const worker = {
  workerId: 'tower-prod-local-01', deploymentId: 'production', baseUrl: 'http://worker', capabilities: ['job'], projectIds: ['old'],
  capacity: { cpuTotal: 4, memoryMbTotal: 8192, activeRuns: 0, maxRuns: 5 }, draining: false,
  registeredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), status: 'healthy',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue(worker as any);
  vi.mocked(requestProjectWorkerAssignment).mockResolvedValue({ status: 'pending' } as any);
});

describe('automatic Project Worker assignment request', () => {
  it('queues one standard production Project after creation', async () => {
    await expect(requestAutomaticProjectWorkerAssignment({ projectId: 'p1', rootPath: '/workspace/projects/p1', userId: 7, env: { NODE_ENV: 'production', TOWER_PRIMARY_WORKER_ID: 'tower-projects-local-01' } }))
      .resolves.toBe('queued');
    expect(requestProjectWorkerAssignment).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', deploymentId: 'production', workerId: 'tower-projects-local-01' }));
  });

  it.each([
    [{ NODE_ENV: 'development' }, '/workspace/projects/p1', null],
    [{ NODE_ENV: 'production' }, '/workspace/projects/p1', 'system'],
    [{ NODE_ENV: 'production' }, '/home/tower/tower', null],
  ] as const)('skips ineligible Project execution planes', async (env, rootPath, systemKey) => {
    await expect(requestAutomaticProjectWorkerAssignment({ projectId: 'p1', rootPath, systemKey, env: env as any })).resolves.toBe('skipped');
    expect(requestProjectWorkerAssignment).not.toHaveBeenCalled();
  });

  it('skips an unhealthy or draining primary without failing Project creation', async () => {
    vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({ ...worker, draining: true } as any);
    await expect(requestAutomaticProjectWorkerAssignment({ projectId: 'p1', rootPath: '/workspace/projects/p1', env: { NODE_ENV: 'production', TOWER_PRIMARY_WORKER_ID: 'tower-projects-local-01' } })).resolves.toBe('skipped');
  });

  it('skips when this VM has no explicitly configured shared primary Worker', async () => {
    await expect(requestAutomaticProjectWorkerAssignment({ projectId: 'p1', rootPath: '/workspace/projects/p1', env: { NODE_ENV: 'production' } })).resolves.toBe('skipped');
    expect(getPersistedWorkbenchWorker).not.toHaveBeenCalled();
  });
});
