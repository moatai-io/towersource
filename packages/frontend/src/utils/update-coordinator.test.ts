import { describe, it, expect } from 'vitest';
import {
  isUserBusyWithTurn,
  canSafelyReloadApp,
  shouldAutoApplyDeferredUpdate,
  evaluateBuildIdChange,
  type ReloadSafetySnapshot,
  type UpdateStateSnapshot,
} from './update-coordinator';

const idleSnap: ReloadSafetySnapshot = {
  isStreaming: false,
  hasPendingQuestion: false,
  queuedMessageCount: 0,
};

describe('isUserBusyWithTurn / canSafelyReloadApp', () => {
  it('idle snapshot is safe to reload', () => {
    expect(isUserBusyWithTurn(idleSnap)).toBe(false);
    expect(canSafelyReloadApp(idleSnap)).toBe(true);
  });

  it('streaming is busy', () => {
    expect(isUserBusyWithTurn({ ...idleSnap, isStreaming: true })).toBe(true);
    expect(canSafelyReloadApp({ ...idleSnap, isStreaming: true })).toBe(false);
  });

  it('pending question is busy (user owes the AI an answer)', () => {
    expect(isUserBusyWithTurn({ ...idleSnap, hasPendingQuestion: true })).toBe(true);
  });

  it('queued messages are busy (user has typed-ahead work)', () => {
    expect(isUserBusyWithTurn({ ...idleSnap, queuedMessageCount: 2 })).toBe(true);
  });

  it('queuedMessageCount of 0 is not busy', () => {
    expect(isUserBusyWithTurn({ ...idleSnap, queuedMessageCount: 0 })).toBe(false);
  });
});

describe('shouldAutoApplyDeferredUpdate', () => {
  const stateAvailableDeferred: UpdateStateSnapshot = {
    updateAvailable: true,
    deferredUpdateRequested: true,
  };

  it('fires when update is available, deferred, and user is idle', () => {
    expect(shouldAutoApplyDeferredUpdate(stateAvailableDeferred, idleSnap)).toBe(true);
  });

  it('does not fire when no update is available', () => {
    expect(
      shouldAutoApplyDeferredUpdate(
        { updateAvailable: false, deferredUpdateRequested: true },
        idleSnap,
      ),
    ).toBe(false);
  });

  it('does not fire when deferred was not requested', () => {
    expect(
      shouldAutoApplyDeferredUpdate(
        { updateAvailable: true, deferredUpdateRequested: false },
        idleSnap,
      ),
    ).toBe(false);
  });

  it('does not fire while the user is still streaming', () => {
    expect(
      shouldAutoApplyDeferredUpdate(stateAvailableDeferred, { ...idleSnap, isStreaming: true }),
    ).toBe(false);
  });

  it('does not fire while a pending question is open', () => {
    expect(
      shouldAutoApplyDeferredUpdate(stateAvailableDeferred, { ...idleSnap, hasPendingQuestion: true }),
    ).toBe(false);
  });

  it('does not fire while messages are queued', () => {
    expect(
      shouldAutoApplyDeferredUpdate(stateAvailableDeferred, { ...idleSnap, queuedMessageCount: 1 }),
    ).toBe(false);
  });
});

describe('evaluateBuildIdChange', () => {
  it('returns first-seen when there is no current buildId yet', () => {
    expect(evaluateBuildIdChange('', 'abc', idleSnap)).toEqual({
      kind: 'first-seen',
      latestBuildId: 'abc',
    });
  });

  it('returns no-change when the buildIds match', () => {
    expect(evaluateBuildIdChange('abc', 'abc', idleSnap)).toEqual({
      kind: 'no-change',
      latestBuildId: 'abc',
    });
  });

  it('returns no-change when nextBuildId is empty', () => {
    expect(evaluateBuildIdChange('abc', '', idleSnap)).toEqual({
      kind: 'no-change',
      latestBuildId: 'abc',
    });
  });

  it('returns changed-available when build differs and user is idle', () => {
    expect(evaluateBuildIdChange('abc', 'def', idleSnap)).toEqual({
      kind: 'changed-available',
      latestBuildId: 'def',
    });
  });

  it('returns changed-busy when build differs and user is streaming', () => {
    expect(
      evaluateBuildIdChange('abc', 'def', { ...idleSnap, isStreaming: true }),
    ).toEqual({ kind: 'changed-busy', latestBuildId: 'def' });
  });

  it('returns changed-busy when build differs and a question is pending', () => {
    expect(
      evaluateBuildIdChange('abc', 'def', { ...idleSnap, hasPendingQuestion: true }),
    ).toEqual({ kind: 'changed-busy', latestBuildId: 'def' });
  });

  it('returns changed-busy when build differs and there are queued messages', () => {
    expect(
      evaluateBuildIdChange('abc', 'def', { ...idleSnap, queuedMessageCount: 3 }),
    ).toEqual({ kind: 'changed-busy', latestBuildId: 'def' });
  });
});
