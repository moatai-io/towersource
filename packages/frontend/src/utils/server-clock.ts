// Owns: best-effort browser/server wall-clock offset for elapsed-time UI.
// Public API: syncServerClock, serverNowMs.

let serverClockOffsetMs = 0;
let hasServerClockSample = false;

/**
 * Update the browser/server offset from a timestamp generated when the frame was sent.
 *
 * A delayed or replayed frame makes `parsed - receivedAt` artificially smaller. Accepting
 * that sample used to move the UI clock backwards, so a ten-minute run could suddenly
 * appear to be only a few seconds old. The largest observed offset is the least-delayed
 * sample and therefore the safest estimate for elapsed-time display.
 */
export function syncServerClock(serverNow: unknown, receivedAt = Date.now()): void {
  if (typeof serverNow !== 'string') return;
  const parsed = Date.parse(serverNow);
  if (!Number.isFinite(parsed)) return;
  const candidateOffsetMs = parsed - receivedAt;
  if (!hasServerClockSample || candidateOffsetMs > serverClockOffsetMs) {
    serverClockOffsetMs = candidateOffsetMs;
    hasServerClockSample = true;
  }
}

/** Return the current wall time in the backend clock domain. */
export function serverNowMs(localNow = Date.now()): number {
  return localNow + serverClockOffsetMs;
}

/** Test/debug accessor without exposing mutable module state. */
export function serverClockOffset(): number {
  return serverClockOffsetMs;
}
