import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expireStaleServices, reconcileRuntimeBoxServices } from './service-registry.js';
import { reconcileStaleWorkbenchJobs } from '../execution/jobs/job-registry.js';
import { countRunningBoxes, reconcileRuntimeBoxes } from './runtime-box-manager.js';
import { startRuntimeBoxCron, stopRuntimeBoxCron } from './idle-stop-cron.js';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn().mockResolvedValue([]) }));
vi.mock('./service-registry.js', () => ({ expireStaleServices: vi.fn(), reconcileRuntimeBoxServices: vi.fn() }));
vi.mock('../execution/jobs/job-registry.js', () => ({ reconcileStaleWorkbenchJobs: vi.fn() }));
vi.mock('./runtime-box-manager.js', () => ({ countRunningBoxes: vi.fn(), stopBox: vi.fn(), reconcileRuntimeBoxes: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  stopRuntimeBoxCron();
  vi.mocked(countRunningBoxes).mockResolvedValue(0);
  vi.mocked(reconcileRuntimeBoxes).mockResolvedValue(0);
  vi.mocked(reconcileRuntimeBoxServices).mockResolvedValue(0);
  vi.mocked(expireStaleServices).mockResolvedValue(0);
  vi.mocked(reconcileStaleWorkbenchJobs).mockResolvedValue(0);
});

describe('Runtime Box startup maintenance', () => {
  it('reconciles stale Workbench Job leases immediately instead of waiting for the first minute tick', async () => {
    startRuntimeBoxCron();
    await vi.waitFor(() => expect(reconcileStaleWorkbenchJobs).toHaveBeenCalledTimes(1));
    expect(reconcileRuntimeBoxes).toHaveBeenCalledTimes(1);
    expect(reconcileRuntimeBoxServices).toHaveBeenCalledTimes(1);
    stopRuntimeBoxCron();
  });
});
