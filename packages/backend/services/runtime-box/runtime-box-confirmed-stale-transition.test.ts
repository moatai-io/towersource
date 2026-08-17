import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transaction, queryOne, execute } = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../db/pg-repo.js', () => ({
  transaction,
  withClient: () => ({ queryOne, execute }),
}));

import { transitionConfirmedStaleRuntime } from './runtime-box-confirmed-stale-transition.js';

describe('confirmed stale Runtime atomic transition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({}));
  });

  it('returns stale without mutating Service or Projection when Box identity changed', async () => {
    queryOne.mockResolvedValue(undefined);
    await expect(transitionConfirmedStaleRuntime({
      boxId: 7,
      expectedStatus: 'running',
      expectedContainerId: 'container-a',
      cause: 'not_found',
    })).resolves.toEqual({ transitioned: false, reason: 'stale_box_state' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('updates Service and Projection inside the same transaction after expected Box transition', async () => {
    queryOne.mockResolvedValue({ id: 7 });
    await expect(transitionConfirmedStaleRuntime({
      boxId: 7,
      expectedStatus: 'running',
      expectedContainerId: 'container-a',
      cause: 'not_running',
    })).resolves.toEqual({ transitioned: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0]).toContain("status <> 'recovery_required'");
  });

  it('does not expose starting as an accepted transition status', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./runtime-box-confirmed-stale-transition.ts', import.meta.url), 'utf8'));
    expect(source).toContain("expectedStatus: 'running'");
    expect(source).not.toContain("expectedStatus: 'running' | 'starting'");
  });
});
