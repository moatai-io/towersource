// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createScrollIntentState, reduceScrollIntent, shouldAutoFollowOutput } from './scrollIntentMachine';

const metrics = (scrollTop: number, scrollHeight = 2_000, clientHeight = 700) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('conversation viewport scrollIntentMachine', () => {
  it('starts pinned to bottom by default', () => {
    const state = createScrollIntentState();

    expect(state.mode).toBe('pinned-to-bottom');
    expect(state.atBottom).toBe(true);
    expect(state.showJumpToLatest).toBe(false);
    expect(shouldAutoFollowOutput(state, 0)).toBe(true);
  });

  it('resets to bottom ownership once per session change', () => {
    const state = reduceScrollIntent(
      createScrollIntentState({ mode: 'user-reading-history', atBottom: false, showJumpToLatest: true }),
      { type: 'session-changed', sessionId: 'session-1', messageCount: 24, nowMs: 1_000 },
    );

    expect(state.activeSessionId).toBe('session-1');
    expect(state.messageCount).toBe(24);
    expect(state.mode).toBe('pinned-to-bottom');
    expect(state.atBottom).toBe(true);
    expect(state.showJumpToLatest).toBe(false);
    expect(shouldAutoFollowOutput(state, 1_100)).toBe(true);
  });

  it('stops auto-follow when the user scrolls away from bottom during streaming', () => {
    const pinned = createScrollIntentState({ mode: 'pinned-to-bottom', atBottom: true });
    const reading = reduceScrollIntent(pinned, { type: 'user-scroll', metrics: metrics(600), nowMs: 2_000 });
    const afterChunk = reduceScrollIntent(reading, { type: 'content-changed', messageCount: 25, nowMs: 2_050 });

    expect(reading.mode).toBe('user-reading-history');
    expect(reading.showJumpToLatest).toBe(true);
    expect(shouldAutoFollowOutput(afterChunk, 2_060)).toBe(false);
  });

  it('resumes auto-follow when the user returns near bottom', () => {
    const reading = createScrollIntentState({ mode: 'user-reading-history', atBottom: false, showJumpToLatest: true });
    const pinned = reduceScrollIntent(reading, { type: 'user-scroll', metrics: metrics(1_260), nowMs: 3_000 });

    expect(pinned.mode).toBe('pinned-to-bottom');
    expect(pinned.atBottom).toBe(true);
    expect(pinned.showJumpToLatest).toBe(false);
    expect(shouldAutoFollowOutput(pinned, 3_010)).toBe(true);
  });

  it('jump-to-latest explicitly returns ownership to bottom pinning', () => {
    const reading = createScrollIntentState({ mode: 'user-reading-history', atBottom: false, showJumpToLatest: true });
    const latest = reduceScrollIntent(reading, { type: 'jump-to-latest', messageCount: 30, nowMs: 4_000 });

    expect(latest.mode).toBe('pinned-to-bottom');
    expect(latest.atBottom).toBe(true);
    expect(latest.showJumpToLatest).toBe(false);
    expect(shouldAutoFollowOutput(latest, 4_500)).toBe(true);
  });

  it('history jumps suppress bottom settle loops until the user returns to bottom', () => {
    const jumping = reduceScrollIntent(
      createScrollIntentState({ mode: 'pinned-to-bottom', atBottom: true, settleUntilMs: 9_000 }),
      { type: 'jump-to-history', nowMs: 5_000 },
    );

    expect(jumping.mode).toBe('jumping');
    expect(jumping.atBottom).toBe(false);
    expect(jumping.showJumpToLatest).toBe(true);
    expect(shouldAutoFollowOutput(jumping, 5_010)).toBe(false);
  });

  it('anchor restoration keeps auto-follow disabled while the restored anchor is above bottom', () => {
    const restoring = reduceScrollIntent(
      createScrollIntentState({ mode: 'pinned-to-bottom', atBottom: true }),
      { type: 'restore-anchor-start', nowMs: 6_000 },
    );
    const restored = reduceScrollIntent(restoring, { type: 'restore-anchor-end', metrics: metrics(240), nowMs: 6_100 });

    expect(restoring.mode).toBe('restoring-anchor');
    expect(shouldAutoFollowOutput(restoring, 6_050)).toBe(false);
    expect(restored.mode).toBe('user-reading-history');
    expect(restored.showJumpToLatest).toBe(true);
  });

  it('does not let compact-finished yank a history reader back to bottom', () => {
    const reading = createScrollIntentState({ mode: 'user-reading-history', atBottom: false, showJumpToLatest: true });
    const afterCompact = reduceScrollIntent(reading, { type: 'compact-finished', nowMs: 7_000 });

    expect(afterCompact).toEqual(reading);
    expect(shouldAutoFollowOutput(afterCompact, 7_100)).toBe(false);
  });
});
