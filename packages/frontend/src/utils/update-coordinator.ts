/**
 * update-coordinator.ts
 *
 * Pure helpers for the Tower frontend update / reload coordinator.
 *
 * The functions in this file MUST stay pure (no React, no zustand, no DOM)
 * so that they can be unit-tested without rendering anything. The React side
 * lives in `hooks/useAppUpdateCoordinator.ts` and only consumes these helpers.
 *
 * See: docs/arch_plan_0412_update_reload_coordinator.md
 */

/**
 * Snapshot of "is the user busy in a turn right now?".
 *
 * Plain data, no methods, no store references — so the same shape can be
 * built from chat-store, room-store, or a test fixture without coupling.
 */
export interface ReloadSafetySnapshot {
  isStreaming: boolean;
  hasPendingQuestion: boolean;
  /** Total queued user messages across the active session(s). */
  queuedMessageCount: number;
}

/**
 * Update state used to decide auto-apply / banner behavior.
 *
 * Mirrors the relevant slice of settings-store but kept as a plain interface
 * so helpers can be tested without touching the store.
 */
export interface UpdateStateSnapshot {
  updateAvailable: boolean;
  deferredUpdateRequested: boolean;
}

/**
 * "Busy" means: a turn is in flight, the user owes the AI an answer, or
 * messages are queued waiting to send. In any of these cases, a hard reload
 * would visibly disrupt the user.
 *
 * Conservative on purpose — see Section 7 of the arch plan.
 */
export function isUserBusyWithTurn(snapshot: ReloadSafetySnapshot): boolean {
  if (snapshot.isStreaming) return true;
  if (snapshot.hasPendingQuestion) return true;
  if (snapshot.queuedMessageCount > 0) return true;
  return false;
}

/**
 * Inverse of {@link isUserBusyWithTurn}, exposed as a separate helper so
 * call sites read naturally ("if (canSafelyReloadApp(snap)) ...").
 */
export function canSafelyReloadApp(snapshot: ReloadSafetySnapshot): boolean {
  return !isUserBusyWithTurn(snapshot);
}

/**
 * Decide whether a deferred update should fire right now.
 *
 * Three conditions must hold:
 *  1. There IS an update available.
 *  2. The user explicitly asked for "apply when turn ends".
 *  3. The user is no longer busy.
 */
export function shouldAutoApplyDeferredUpdate(
  state: UpdateStateSnapshot,
  snapshot: ReloadSafetySnapshot,
): boolean {
  if (!state.updateAvailable) return false;
  if (!state.deferredUpdateRequested) return false;
  if (isUserBusyWithTurn(snapshot)) return false;
  return true;
}

/**
 * Result of comparing a freshly fetched buildId against the one the frontend
 * was running with.
 */
export type BuildIdEvaluation =
  | { kind: 'no-change'; latestBuildId: string | null }
  | { kind: 'first-seen'; latestBuildId: string }
  | { kind: 'changed-available'; latestBuildId: string }
  | { kind: 'changed-busy'; latestBuildId: string };

/**
 * Pure version of the build comparison logic that used to live inline in
 * App.tsx's /api/config fetch effect.
 *
 *  - "no-change": same build, do nothing.
 *  - "first-seen": no prior build to compare against (initial load).
 *  - "changed-available": new build while idle — show a non-blocking banner.
 *  - "changed-busy": new build while the user is in the middle of something —
 *    keep the same banner available without interrupting the work.
 *
 * A healthy tab is never auto-reloaded from this comparison. Automatic reload
 * is reserved for broken chunk/bootstrap recovery paths.
 *
 * Inputs are deliberately raw strings (already normalized by the caller) so
 * this function can be tested without importing app-version.ts.
 */
export function evaluateBuildIdChange(
  currentBuildId: string,
  nextBuildId: string,
  snapshot: ReloadSafetySnapshot,
): BuildIdEvaluation {
  if (!nextBuildId) {
    return { kind: 'no-change', latestBuildId: currentBuildId || null };
  }
  if (!currentBuildId) {
    return { kind: 'first-seen', latestBuildId: nextBuildId };
  }
  if (currentBuildId === nextBuildId) {
    return { kind: 'no-change', latestBuildId: nextBuildId };
  }
  return canSafelyReloadApp(snapshot)
    ? { kind: 'changed-available', latestBuildId: nextBuildId }
    : { kind: 'changed-busy', latestBuildId: nextBuildId };
}
