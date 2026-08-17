// Owns: process-local binding from a live session run to its durable root user turn.
// Public API: setCurrentRootTurn, getCurrentRootTurn, clearCurrentRootTurn. See README.md.

const currentRootTurns = new Map<string, { rootTurnId: string; recovering: boolean }>();

/** Bind the active SDK run to the user message that owns it. */
export function setCurrentRootTurn(sessionId: string, rootTurnId: string | undefined, recovering = false): void {
  if (rootTurnId) currentRootTurns.set(sessionId, { rootTurnId, recovering });
  else currentRootTurns.delete(sessionId);
}

/** Resolve the active root turn at tool-call time; never capture a prior turn in a cached SDK session. */
export function getCurrentRootTurn(sessionId: string): string | undefined {
  return currentRootTurns.get(sessionId)?.rootTurnId;
}

/** True when the current SDK run is an automatic continuation/recovery. */
export function isCurrentRootTurnRecovering(sessionId: string): boolean {
  return currentRootTurns.get(sessionId)?.recovering ?? false;
}

/** Clear only when the run closes so later user turns cannot inherit stale operation identity. */
export function clearCurrentRootTurn(sessionId: string): void {
  currentRootTurns.delete(sessionId);
}
