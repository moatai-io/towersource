import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../task/scheduler-ownership.js', () => ({ scheduledExecutionEnabled: vi.fn() }));
vi.mock('./store.js', () => ({ secretariatStore: { dueUsers: vi.fn() } }));
vi.mock('./service.js', () => ({ secretariatService: { runUser: vi.fn() } }));
import { scheduledExecutionEnabled } from '../task/scheduler-ownership.js';
import { secretariatStore } from './store.js';
import { secretariatService } from './service.js';
import { startSecretariatScheduler, stopSecretariatScheduler, tickSecretariat } from './scheduler.js';
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); vi.mocked(scheduledExecutionEnabled).mockReturnValue(true);
  vi.mocked(secretariatStore.dueUsers).mockResolvedValue([7, 8]); vi.mocked(secretariatService.runUser).mockResolvedValue('skipped'); });
afterEach(() => { stopSecretariatScheduler(); vi.useRealTimers(); });
describe('Secretariat backend lifecycle', () => {
  it('never starts in development or without execution ownership', async () => {
    vi.mocked(scheduledExecutionEnabled).mockReturnValue(false); startSecretariatScheduler();
    await vi.advanceTimersByTimeAsync(120_000); expect(secretariatStore.dueUsers).not.toHaveBeenCalled();
  });
  it('starts exactly one loop, sequential users, and shuts down', async () => {
    startSecretariatScheduler(); startSecretariatScheduler(); await vi.advanceTimersByTimeAsync(60_000);
    expect(secretariatStore.dueUsers).toHaveBeenCalledTimes(1); expect(secretariatService.runUser).toHaveBeenNthCalledWith(1, 7);
    expect(secretariatService.runUser).toHaveBeenNthCalledWith(2, 8); stopSecretariatScheduler();
    await vi.advanceTimersByTimeAsync(120_000); expect(secretariatStore.dueUsers).toHaveBeenCalledTimes(1);
  });
  it('does not overlap ticks while provider work is running', async () => {
    let done!: () => void;
    vi.mocked(secretariatService.runUser).mockImplementationOnce(() => new Promise(resolve => { done = () => resolve('skipped'); }));
    startSecretariatScheduler(); const pending = tickSecretariat(); await Promise.resolve(); await Promise.resolve();
    await tickSecretariat(); expect(secretariatStore.dueUsers).toHaveBeenCalledTimes(1); done(); await pending;
  });
  it('fails closed for absent migration and retries only next tick', async () => {
    vi.mocked(secretariatStore.dueUsers).mockRejectedValue(new Error('missing table'));
    startSecretariatScheduler(); await tickSecretariat(); expect(secretariatService.runUser).not.toHaveBeenCalled();
  });
  it('rechecks scheduling ownership before each user', async () => {
    vi.mocked(secretariatService.runUser).mockImplementationOnce(async () => { vi.mocked(scheduledExecutionEnabled).mockReturnValue(false); return 'skipped'; });
    startSecretariatScheduler(); await tickSecretariat(); expect(secretariatService.runUser).toHaveBeenCalledTimes(1);
  });
});
