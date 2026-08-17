import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, queryOne, execute, withLifecycleLock, tryWithLifecycleLock, assertHeld } = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withLifecycleLock: vi.fn(),
  tryWithLifecycleLock: vi.fn(),
  assertHeld: vi.fn(),
}));

vi.mock('../../db/pg-repo.js', () => ({ query, queryOne, execute }));
vi.mock('./runtime-box-manager.js', () => ({
  BOX_WORKDIR: '/workspace',
  RuntimeBoxError: class RuntimeBoxError extends Error {},
}));
vi.mock('./runtime-box-lifecycle-lock.js', () => ({
  withRuntimeBoxLifecycleLock: withLifecycleLock,
  tryWithRuntimeBoxLifecycleLock: tryWithLifecycleLock,
  assertRuntimeBoxLifecycleLockHeld: assertHeld,
}));
vi.mock('./workbench-tools.js', () => ({ withWorkbenchToolPath: () => '/managed/bin:/usr/bin' }));

import { registerService, startServiceProcess, expireStaleServices, pinService } from './service-registry.js';

const token = { key: 'opaque' };

function service(overrides: Record<string, unknown> = {}) {
  return {
    id: 5, box_id: 9, project_id: 'project-a', name: 'web', command: 'npm run dev', cwd: '/workspace',
    status: 'pending', process_pid: null, external_url: null, ...overrides,
  };
}

describe('Service lifecycle lock behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withLifecycleLock.mockImplementation(async (_boxId: number, fn: (held: unknown) => Promise<unknown>) => fn(token));
    tryWithLifecycleLock.mockImplementation(async (_boxId: number, fn: (held: unknown) => Promise<unknown>) => ({ acquired: true, value: await fn(token) }));
  });

  it('re-reads Box ownership under L before register mutation', async () => {
    queryOne.mockResolvedValue({ id: 9, project_id: 'other-project', status: 'running' });

    await expect(registerService({
      boxId: 9,
      projectId: 'project-a',
      name: 'web',
      command: 'npm run dev',
      userId: 'user-1',
    })).rejects.toThrow(/does not belong/);

    expect(withLifecycleLock).toHaveBeenCalledWith(9, expect.any(Function));
    expect(assertHeld).toHaveBeenCalledWith(token, 9);
    expect(query).not.toHaveBeenCalled();
  });

  it('re-reads Service and Box under L and refuses start on a stopped Box', async () => {
    queryOne
      .mockResolvedValueOnce(service())
      .mockResolvedValueOnce(service())
      .mockResolvedValueOnce({ id: 9, project_id: 'project-a', status: 'stopped', container_id: null });

    await expect(startServiceProcess(5)).rejects.toThrow(/not running/);

    expect(withLifecycleLock).toHaveBeenCalledWith(9, expect.any(Function));
    expect(assertHeld).toHaveBeenCalledWith(token, 9);
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a Service whose Box ownership changed while waiting for L', async () => {
    queryOne
      .mockResolvedValueOnce(service())
      .mockResolvedValueOnce(service({ box_id: 10 }));

    await expect(startServiceProcess(5)).rejects.toThrow(/changed Runtime Box ownership/);
    expect(queryOne).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('re-checks expiration under L so a concurrent pin wins', async () => {
    const expiredCandidate = service({
      status: 'running',
      pinned: false,
      expires_at: new Date(Date.now() - 60_000),
      process_pid: 123,
    });
    query.mockResolvedValueOnce([expiredCandidate]);
    queryOne.mockResolvedValueOnce(service({
      status: 'running',
      pinned: true,
      expires_at: null,
      process_pid: 123,
    }));

    await expect(expireStaleServices()).resolves.toBe(0);

    expect(tryWithLifecycleLock).toHaveBeenCalledWith(9, expect.any(Function));
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('re-checks expiration under L so a concurrent TTL extension wins', async () => {
    const expiredCandidate = service({
      status: 'running',
      pinned: false,
      expires_at: new Date(Date.now() - 60_000),
      process_pid: 123,
    });
    query.mockResolvedValueOnce([expiredCandidate]);
    queryOne.mockResolvedValueOnce(service({
      status: 'running',
      pinned: false,
      expires_at: new Date(Date.now() + 60_000),
      process_pid: 123,
    }));

    await expect(expireStaleServices()).resolves.toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips a contended expire candidate without mutation', async () => {
    query.mockResolvedValueOnce([service({
      status: 'running',
      pinned: false,
      expires_at: new Date(Date.now() - 60_000),
      process_pid: 123,
    })]);
    tryWithLifecycleLock.mockResolvedValueOnce({ acquired: false });

    await expect(expireStaleServices()).resolves.toBe(0);
    expect(queryOne).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('pins either Runtime Box or remote Worker services without taking a Box lifecycle lock', async () => {
    queryOne.mockResolvedValueOnce(service({ runner_kind: 'remote-worker', box_id: null, worker_id: 'worker-1' }));
    query.mockResolvedValueOnce([service({ runner_kind: 'remote-worker', box_id: null, worker_id: 'worker-1', pinned: true, purpose: 'keep preview' })]);

    await expect(pinService(5, 'keep preview')).resolves.toMatchObject({ pinned: true });
    expect(withLifecycleLock).not.toHaveBeenCalled();
    expect(assertHeld).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SET pinned = true'), expect.arrayContaining([5, 'keep preview']));
  });
});
