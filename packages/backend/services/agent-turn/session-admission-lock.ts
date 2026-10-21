/** Process-local FIFO admission mutex shared by entry points.
 * Not a PostgreSQL ownership fence and not sufficient across backend processes.
 * Release before long-running engine work; always release in finally on failure.
 */
const sessionChatLocks = new Map<string, Promise<void>>();

/** Acquire the per-session chat lock; resolves with a one-shot release fn. */
export async function acquireSessionAdmissionLock(sessionId: string): Promise<() => void> {
  const prev = sessionChatLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  // The next acquirer waits for THIS holder to release (arrival order preserved).
  const tail = prev.then(() => held);
  sessionChatLocks.set(sessionId, tail);
  await prev; // wait our turn
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    // GC: if we're still the tail (no later waiter chained on), drop the entry.
    if (sessionChatLocks.get(sessionId) === tail) sessionChatLocks.delete(sessionId);
  };
}

