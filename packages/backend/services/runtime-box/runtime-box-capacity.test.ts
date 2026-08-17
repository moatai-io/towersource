import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({ queryOne: vi.fn(), execute: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => dbMocks);
vi.mock('../../config.js', () => ({ config: { runtimeBox: { maxRunning: 8, maxRunningPerUser: 5, maxMemoryMb: 3072 } } }));

const osMocks = vi.hoisted(() => ({ cpus: vi.fn(), totalmem: vi.fn() }));
vi.mock('os', () => ({ default: osMocks }));

import { getRuntimeBoxCapacity, updateRuntimeBoxCapacity } from './runtime-box-capacity.js';

describe('runtime box capacity settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    osMocks.cpus.mockReturnValue(Array.from({ length: 8 }, () => ({})));
    osMocks.totalmem.mockReturnValue(32 * 1024 ** 3);
    dbMocks.queryOne.mockResolvedValue({ value: { maxRunning: 8, maxRunningPerUser: 5 } });
    dbMocks.execute.mockResolvedValue(undefined);
  });

  it('reports host specs and conservative recommendations', async () => {
    const result = await getRuntimeBoxCapacity();
    expect(result.host.cpuThreads).toBe(8);
    expect(result.host.totalMemoryMb).toBe(32768);
    expect(result.recommended).toEqual({ maxRunning: 7, maxRunningPerUser: 5 });
  });

  it('persists over-recommendation values instead of hard-blocking them', async () => {
    dbMocks.queryOne.mockResolvedValue({ value: { maxRunning: 20, maxRunningPerUser: 12 } });
    const result = await updateRuntimeBoxCapacity({ maxRunning: 20, maxRunningPerUser: 12 }, 1);
    expect(dbMocks.execute).toHaveBeenCalled();
    expect(result.current).toEqual({ maxRunning: 20, maxRunningPerUser: 12 });
  });

  it('rejects non-positive values', async () => {
    await expect(updateRuntimeBoxCapacity({ maxRunning: 0, maxRunningPerUser: 5 }, 1)).rejects.toThrow('positive integer');
  });
});
