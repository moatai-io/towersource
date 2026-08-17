import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearWorkbenchWorkerRegistry,
  heartbeatWorkbenchWorker,
  listWorkbenchWorkers,
  registerWorkbenchWorker,
  selectWorkbenchWorker,
  setWorkbenchWorkerDrain,
} from './workbench-worker-registry.js';

const capacity = (activeRuns: number, maxRuns = 4) => ({ cpuTotal: 4, memoryMbTotal: 8192, activeRuns, maxRuns });
beforeEach(clearWorkbenchWorkerRegistry);

describe('Workbench Worker registry and scheduler seam', () => {
  it('selects the healthy Project-authorized Worker with the most free slots', () => {
    registerWorkbenchWorker({ workerId: 'worker-b', baseUrl: 'https://b.internal/', capabilities: ['shell', 'job'], projectIds: ['p'], capacity: capacity(3), now: 1_000 });
    registerWorkbenchWorker({ workerId: 'worker-a', baseUrl: 'https://a.internal', capabilities: ['shell', 'job'], projectIds: ['p'], capacity: capacity(1), now: 1_000 });
    expect(selectWorkbenchWorker({ projectId: 'p', requiredCapabilities: ['job'], now: 2_000 })).toMatchObject({ workerId: 'worker-a', baseUrl: 'https://a.internal', status: 'healthy' });
  });

  it('excludes stale, draining, full, unauthorized, and capability-missing Workers', () => {
    registerWorkbenchWorker({ workerId: 'stale', baseUrl: 'https://stale.internal', capabilities: ['job'], projectIds: ['p'], capacity: capacity(0), now: 1_000 });
    registerWorkbenchWorker({ workerId: 'drain', baseUrl: 'https://drain.internal', capabilities: ['job'], projectIds: ['p'], capacity: capacity(0), now: 20_000 });
    setWorkbenchWorkerDrain('drain', true);
    registerWorkbenchWorker({ workerId: 'full', baseUrl: 'https://full.internal', capabilities: ['job'], projectIds: ['p'], capacity: capacity(4), now: 20_000 });
    registerWorkbenchWorker({ workerId: 'other-project', baseUrl: 'https://other.internal', capabilities: ['job'], projectIds: ['q'], capacity: capacity(0), now: 20_000 });
    registerWorkbenchWorker({ workerId: 'no-browser', baseUrl: 'https://plain.internal', capabilities: ['job'], projectIds: ['p'], capacity: capacity(0), now: 20_000 });
    expect(() => selectWorkbenchWorker({ projectId: 'p', requiredCapabilities: ['browser'], now: 21_000, staleAfterMs: 5_000 })).toThrow('NO_ELIGIBLE_WORKER');
    expect(listWorkbenchWorkers({ now: 21_000, staleAfterMs: 5_000 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ workerId: 'stale', status: 'stale' }), expect.objectContaining({ workerId: 'drain', status: 'draining' }),
    ]));
  });

  it('refreshes heartbeat capacity without changing registration identity', () => {
    const first = registerWorkbenchWorker({ workerId: 'worker-a', baseUrl: 'https://a.internal', capabilities: ['job'], projectIds: ['p'], capacity: capacity(0), now: 1_000 });
    const heartbeat = heartbeatWorkbenchWorker({ workerId: 'worker-a', capacity: capacity(2), now: 5_000 });
    expect(heartbeat).toMatchObject({ registeredAt: first.registeredAt, heartbeatAt: new Date(5_000).toISOString(), capacity: { activeRuns: 2 } });
  });
});
