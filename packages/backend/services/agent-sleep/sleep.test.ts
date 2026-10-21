import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => vi.fn());
vi.mock('../../db/pg-repo.js', () => ({ query }));
import { sleep, validateSleepInput, isSessionSleeping, cancelSessionSleep, interruptRestartedSleepTurns, nextClaudeMessageWithSleep } from './sleep.js';

beforeEach(() => { vi.useFakeTimers(); query.mockReset().mockResolvedValue([{ id: 'root' }]); });
afterEach(() => { vi.useRealTimers(); });
const wait = { durationSeconds: 1800, reason: '확인 작업을 다시 수행합니다.' };
const ctx = { sessionId: 's', rootTurnId: 'root' };

describe('bounded sleep', () => {
  it.each([0, -1, 3601, 1.5, NaN, Infinity])('rejects invalid duration %s', durationSeconds => {
    expect(() => validateSleepInput({ ...wait, durationSeconds })).toThrow('durationSeconds');
  });
  it.each(['', '   ', 'x'.repeat(501)])('rejects invalid reason', reason => {
    expect(() => validateSleepInput({ ...wait, reason })).toThrow('reason');
  });
  it('waits for 30 minutes without polling or model calls and clears its timer', async () => {
    const run = sleep(wait, ctx);
    await vi.advanceTimersByTimeAsync(1799_000);
    expect(isSessionSleeping('s')).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await run).toMatchObject({ ok: true, status: 'completed', cancelled: false, durationSeconds: 1800 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(isSessionSleeping('s')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('supports the 3600-second upper bound', async () => {
    const run = sleep({ ...wait, durationSeconds: 3600 }, ctx);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(await run).toMatchObject({ status: 'completed', durationSeconds: 3600 });
  });
  it('cancels the timer promptly via AbortSignal and permits another identical wait', async () => {
    const abort = new AbortController();
    const run = sleep(wait, { ...ctx, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(1000);
    abort.abort();
    expect(await run).toMatchObject({ ok: false, status: 'cancelled', cancelled: true });
    expect(vi.getTimerCount()).toBe(0);
    const repeated = sleep(wait, ctx);
    await vi.advanceTimersByTimeAsync(1800_000);
    expect(await repeated).toMatchObject({ status: 'completed' });
  });
  it('rejects concurrent waits in one session but not other sessions', async () => {
    const run = sleep(wait, ctx);
    await expect(sleep(wait, ctx)).rejects.toThrow('Only one sleep');
    const other = sleep(wait, { sessionId: 'other', rootTurnId: 'other-root' });
    cancelSessionSleep('s'); cancelSessionSleep('other');
    expect(await run).toMatchObject({ cancelled: true });
    expect(await other).toMatchObject({ cancelled: true });
  });
  it('does not start or persist a pre-aborted wait', async () => {
    await expect(sleep(wait, { ...ctx, signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    expect(query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails closed when the wait owner cannot be persisted', async () => {
    query.mockResolvedValue([]);
    await expect(sleep(wait, ctx)).rejects.toThrow('persisted owning user message');
    expect(isSessionSleeping('s')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('handles cancellation while saving the durable marker', async () => {
    let saved!: (rows: { id: string }[]) => void;
    query.mockImplementationOnce(() => new Promise(resolve => { saved = resolve; }));
    const abort = new AbortController();
    const run = sleep(wait, { ...ctx, signal: abort.signal });
    abort.abort(); saved([{ id: 'root' }]);
    expect(await run).toMatchObject({ status: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fences restart waits before generic auto recovery, including legacy Claude without a turn row', async () => {
    query.mockResolvedValue([{ root_turn_id: 'root', session_id: 's' }]);
    expect(await interruptRestartedSleepTurns()).toEqual([{ rootTurnId: 'root', sessionId: 's' }]);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('INSERT INTO agent_turns');
    expect(sql).toContain("'needs_attention'");
    expect(sql).toContain('sleep_restart_interrupted');
    expect(sql).toContain('"interrupted"');
  });
});

describe('Claude watchdog integration', () => {
  it('permits a 30-minute sleep across a 10-minute stream silence timeout', async () => {
    const run = sleep(wait, ctx);
    let message!: (value: string) => void;
    const next = nextClaudeMessageWithSleep(new Promise<string>(resolve => { message = resolve; }), 600_000, () => isSessionSleeping('s'), 'stream idle');
    await vi.advanceTimersByTimeAsync(1799_000);
    expect(isSessionSleeping('s')).toBe(true);
    message('tool result');
    expect(await next).toBe('tool result');
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('grants a full normal timeout after the sleep ends', async () => {
    let sleeping = true;
    let message!: (value: string) => void;
    const next = nextClaudeMessageWithSleep(new Promise<string>(resolve => { message = resolve; }), 600_000, () => sleeping, 'stream idle');
    await vi.advanceTimersByTimeAsync(1800_000);
    sleeping = false;
    await vi.advanceTimersByTimeAsync(599_999);
    message('first token'); expect(await next).toBe('first token');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps normal tool timeouts active and cleans timers on success', async () => {
    const pending = nextClaudeMessageWithSleep(new Promise<void>(() => {}), 1000, () => false, 'stream idle');
    const rejected = expect(pending).rejects.toThrow('Claude stream watchdog timeout');
    await vi.advanceTimersByTimeAsync(1000); await rejected;
    expect(await nextClaudeMessageWithSleep(Promise.resolve('done'), 1000, () => false, 'stream idle')).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });
});
