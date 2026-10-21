import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), messages: vi.fn(), generate: vi.fn(), save: vi.fn() }));
vi.mock('./session-manager.js', () => ({ getSession: mocks.session }));
vi.mock('../message-store.js', () => ({ getMessages: mocks.messages }));
vi.mock('../auto-namer.js', () => ({ generateSessionNameResult: mocks.generate }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.save }));
import { autoNameSession } from './auto-name-session.js';

describe('autoNameSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.session.mockResolvedValue({ name: 'Session 123', autoNamed: 1 });
    mocks.messages.mockResolvedValue([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }]);
    mocks.generate.mockResolvedValue({ name: 'Generated', generated: true });
    mocks.save.mockResolvedValue({ name: 'Generated' });
  });
  it('retries a failed generation without saving its fallback', async () => {
    mocks.generate.mockResolvedValueOnce({ name: 'fallback', generated: false });
    expect(await autoNameSession('retry')).toEqual({ status: 'generated', name: 'Generated' });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0][1]).toEqual(['retry', 'Generated', 'Session 123']);
  });
  it('retains eligibility after two failures and retries on a later call', async () => {
    mocks.generate.mockResolvedValue({ name: 'fallback', generated: false });
    expect(await autoNameSession('failed')).toEqual({ status: 'retryable' });
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.generate.mockResolvedValue({ name: 'Generated', generated: true });
    expect((await autoNameSession('failed')).status).toBe('generated');
  });
  it('coalesces concurrent REST and completion calls', async () => {
    const a = autoNameSession('shared');
    const b = autoNameSession('shared');
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it.each([{ name: 'Manual', autoNamed: 0 }, { name: 'Session manual', autoNamed: 0 }, { name: 'Already generated', autoNamed: 1 }])('skips protected names: %j', async session => {
    mocks.session.mockResolvedValue(session);
    expect((await autoNameSession('protected')).status).toBe('skipped');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('does not report success if a concurrent manual rename wins', async () => {
    mocks.save.mockResolvedValue(undefined);
    expect((await autoNameSession('race')).status).toBe('skipped');
    expect(mocks.save.mock.calls[0][0]).toContain('name = $3');
    expect(mocks.save.mock.calls[0][0]).toContain('COALESCE(auto_named, 1) <> 0');
  });
  it('skips missing exchanges', async () => {
    mocks.messages.mockResolvedValue([{ role: 'user', content: 'hello' }]);
    expect((await autoNameSession('empty')).status).toBe('skipped');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('serializes different sessions in FIFO order and coalesces queued duplicates', async () => {
    let release!: (value: { name: string; generated: boolean }) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    mocks.generate.mockImplementationOnce(() => {
      started();
      return new Promise(resolve => { release = resolve; });
    });
    const first = autoNameSession('fifo-first');
    const second = autoNameSession('fifo-second');
    const third = autoNameSession('fifo-third');
    expect(autoNameSession('fifo-second')).toBe(second);
    await firstStarted;
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.session).toHaveBeenCalledTimes(1);
    release({ name: 'Generated', generated: true });
    await Promise.all([first, second, third]);
    expect(mocks.generate.mock.calls.map(call => call[2]))
      .toEqual(['fifo-first', 'fifo-second', 'fifo-third']);
  });

  it('continues queued jobs after an unexpected failure and releases the failed session', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('synthetic provider failure'));
    const first = autoNameSession('queue-failed');
    const second = autoNameSession('queue-after-failure');
    await expect(first).rejects.toThrow('synthetic provider failure');
    expect((await second).status).toBe('generated');
    expect((await autoNameSession('queue-failed')).status).toBe('generated');
  });

  it('checks eligibility after waiting rather than using a stale session snapshot', async () => {
    let release!: (value: { name: string; generated: boolean }) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    mocks.generate.mockImplementationOnce(() => {
      started();
      return new Promise(resolve => { release = resolve; });
    });
    const first = autoNameSession('blocking');
    const waiting = autoNameSession('renamed-while-waiting');
    await firstStarted;
    mocks.session.mockResolvedValue({ name: 'Manual title', autoNamed: 0 });
    release({ name: 'Generated', generated: true });
    await first;
    expect((await waiting).status).toBe('skipped');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('keeps a retry inside its queue slot before starting the next session', async () => {
    mocks.generate.mockResolvedValueOnce({ name: 'fallback', generated: false });
    await Promise.all([autoNameSession('retry-first'), autoNameSession('after-retry')]);
    expect(mocks.generate.mock.calls.map(call => call[2]))
      .toEqual(['retry-first', 'retry-first', 'after-retry']);
  });

});
