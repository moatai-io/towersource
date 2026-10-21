import { describe, expect, it, vi } from 'vitest';
import { createAgentTurnDispatcher, type AgentTurnDispatchCandidate } from './turn-dispatcher.js';

const candidate: AgentTurnDispatchCandidate = {
  rootTurnId: 'root-1',
  sessionId: 'session-1',
  engineSessionId: '/tmp/pi-session.jsonl',
  acceptedAt: '2026-08-03T00:00:00.000Z',
};

describe('agent turn dispatcher', () => {
  it('dispatches due durable retries through one wake boundary', async () => {
    vi.useFakeTimers();
    const findDue = vi.fn().mockResolvedValue([candidate]);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createAgentTurnDispatcher({
      findDue,
      dispatch,
      intervalMs: 60_000,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    dispatcher.start();
    await vi.runOnlyPendingTimersAsync();

    expect(findDue).toHaveBeenCalledWith({ limit: 20 });
    expect(dispatch).toHaveBeenCalledWith([candidate]);

    dispatcher.stop();
    vi.useRealTimers();
  });

  it('coalesces wake requests while a scan is active', async () => {
    vi.useFakeTimers();
    let releaseFirstScan!: () => void;
    const firstScan = new Promise<void>((resolve) => { releaseFirstScan = resolve; });
    const findDue = vi.fn()
      .mockImplementationOnce(async () => {
        await firstScan;
        return [];
      })
      .mockResolvedValue([]);
    const dispatcher = createAgentTurnDispatcher({
      findDue,
      dispatch: vi.fn().mockResolvedValue(undefined),
      intervalMs: 60_000,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    dispatcher.wake();
    await vi.advanceTimersByTimeAsync(0);
    releaseFirstScan();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);

    expect(findDue).toHaveBeenCalledTimes(2);

    dispatcher.stop();
    vi.useRealTimers();
  });

  it('stops future scans and delayed wakes', async () => {
    vi.useFakeTimers();
    const findDue = vi.fn().mockResolvedValue([]);
    const dispatcher = createAgentTurnDispatcher({
      findDue,
      dispatch: vi.fn().mockResolvedValue(undefined),
      intervalMs: 1_000,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    dispatcher.start();
    dispatcher.wakeSoon(500);
    dispatcher.stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(findDue).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});


describe('abandoned owner reconciliation', () => {
  it('retries discovery after a temporary reconciliation failure', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('temporary DB outage'))
      .mockImplementation(async () => { order.push('reconcile'); return 1; });
    const findDue = vi.fn(async () => { order.push('discover'); return [candidate]; });
    const dispatch = vi.fn(async () => { order.push('dispatch'); });
    const dispatcher = createAgentTurnDispatcher({ reconcile, findDue, dispatch,
      intervalMs: 1000, logger: { log: vi.fn(), warn: vi.fn() } });
    try {
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['reconcile', 'discover', 'dispatch']);
      expect(dispatch).toHaveBeenCalledWith([candidate]);
    } finally { dispatcher.stop(); vi.useRealTimers(); }
  });
});
