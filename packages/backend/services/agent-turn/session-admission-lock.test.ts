import { describe, it, expect } from 'vitest';
import { acquireSessionAdmissionLock as acquire } from './session-admission-lock';

describe('shared session admission mutex', () => {
  it('serializes same-session arrivals in FIFO order', async () => {
    const first = await acquire('fifo');
    const order: number[] = [];
    const second = acquire('fifo').then(release => { order.push(2); release(); });
    const third = acquire('fifo').then(release => { order.push(3); release(); });
    await Promise.resolve();
    expect(order).toEqual([]);
    first(); await Promise.all([second, third]);
    expect(order).toEqual([2, 3]);
  });
  it('does not serialize unrelated sessions', async () => {
    const a = await acquire('a');
    const b = await acquire('b');
    b(); a();
  });
  it('old double release cannot unlock a newer holder', async () => {
    const old = await acquire('double');
    const nextPromise = acquire('double');
    old(); const next = await nextPromise;
    let entered = false;
    const third = acquire('double').then(release => { entered = true; release(); });
    old(); await Promise.resolve(); expect(entered).toBe(false);
    next(); await third; expect(entered).toBe(true);
  });
  it('finally release after failure allows later work', async () => {
    await expect((async () => {
      const release = await acquire('failure');
      try { throw new Error('fixture'); } finally { release(); }
    })()).rejects.toThrow('fixture');
    const release = await acquire('failure'); release();
  });
});
