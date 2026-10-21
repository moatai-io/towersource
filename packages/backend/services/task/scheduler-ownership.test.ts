import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ locked: false }));
const clients = vi.hoisted(() => [] as any[]);
vi.mock('../../db/pg.js', () => ({ getPgPool: () => ({ connect: async () => {
  const client = { release: vi.fn(), query: vi.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      if (state.locked) return { rows: [{ locked: false }] };
      state.locked = true;
      return { rows: [{ locked: true }] };
    }
    state.locked = false;
    return { rows: [] };
  }) };
  clients.push(client);
  return client;
} }) }));
import { scheduledExecutionEnabled, withSchedulerTickLock } from './scheduler-ownership.js';

beforeEach(() => { state.locked = false; clients.length = 0; });
describe('scheduler ownership', () => {
  it('defaults development off and production on; allows explicit isolated testing', () => {
    expect(scheduledExecutionEnabled({ TOWER_DEPLOYMENT_ID: 'development' })).toBe(false);
    expect(scheduledExecutionEnabled({ NODE_ENV: 'production', PORT: '32355' })).toBe(false);
    expect(scheduledExecutionEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(scheduledExecutionEnabled({ TOWER_DEPLOYMENT_ID: 'development', TOWER_SCHEDULER_ENABLED: 'true' })).toBe(true);
    expect(scheduledExecutionEnabled({ NODE_ENV: 'production', TOWER_SCHEDULER_ENABLED: 'false' })).toBe(false);
  });
  it('does not execute a second tick while the first holds its database lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withSchedulerTickLock(() => gate);
    await vi.waitFor(() => expect(state.locked).toBe(true));
    const second = vi.fn();
    await withSchedulerTickLock(second);
    expect(second).not.toHaveBeenCalled();
    release(); await first;
    expect(state.locked).toBe(false);
    await withSchedulerTickLock(second);
    expect(second).toHaveBeenCalledOnce();
  });
  it('releases its lock and connection when execution throws', async () => {
    await expect(withSchedulerTickLock(async () => { throw new Error('runner failed'); })).rejects.toThrow('runner failed');
    expect(state.locked).toBe(false);
    expect(clients[0].release).toHaveBeenCalledWith(false);
  });
});
