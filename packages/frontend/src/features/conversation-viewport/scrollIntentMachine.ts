/**
 * Owns: Pure state machine for conversation scroll ownership.
 * Public API: createScrollIntentState, reduceScrollIntent, shouldAutoFollowOutput.
 * See README.md.
 */

import {
  DEFAULT_SCROLL_INTENT_POLICY,
  type ScrollIntentPolicy,
  type ScrollIntentState,
  type ViewportMetrics,
} from './viewportTypes';
import { isNearBottom } from './scrollPositionMath';

export type ScrollIntentEvent =
  | { type: 'session-changed'; sessionId: string | null; messageCount: number; nowMs: number }
  | { type: 'messages-loaded'; messageCount: number; nowMs: number }
  | { type: 'streaming-started'; nowMs: number }
  | { type: 'content-changed'; messageCount: number; nowMs: number }
  | { type: 'user-scroll'; metrics: ViewportMetrics; nowMs: number }
  | { type: 'user-scroll-up'; nowMs: number }
  | { type: 'jump-to-latest'; messageCount: number; nowMs: number }
  | { type: 'jump-to-history'; nowMs: number }
  | { type: 'restore-anchor-start'; nowMs: number }
  | { type: 'restore-anchor-end'; metrics: ViewportMetrics; nowMs: number }
  | { type: 'compact-finished'; nowMs: number };

/** Create the initial state for a conversation viewport. */
export function createScrollIntentState(partial: Partial<ScrollIntentState> = {}): ScrollIntentState {
  return {
    mode: 'pinned-to-bottom',
    atBottom: true,
    showJumpToLatest: false,
    settleUntilMs: 0,
    switchSettleUntilMs: 0,
    activeSessionId: null,
    messageCount: 0,
    ...partial,
  };
}

/** Reduce a scroll-intent event into the next state without touching the DOM. */
export function reduceScrollIntent(
  state: ScrollIntentState,
  event: ScrollIntentEvent,
  policy: ScrollIntentPolicy = DEFAULT_SCROLL_INTENT_POLICY,
): ScrollIntentState {
  switch (event.type) {
    case 'session-changed': {
      return {
        ...state,
        activeSessionId: event.sessionId,
        messageCount: event.messageCount,
        mode: 'pinned-to-bottom',
        atBottom: true,
        showJumpToLatest: false,
        settleUntilMs: event.nowMs + policy.sessionSettleMs,
        switchSettleUntilMs: event.nowMs + policy.sessionSettleMs,
      };
    }

    case 'messages-loaded': {
      if (state.mode === 'user-reading-history' || state.mode === 'restoring-anchor') {
        return { ...state, messageCount: event.messageCount };
      }
      return {
        ...state,
        messageCount: event.messageCount,
        mode: 'pinned-to-bottom',
        atBottom: true,
        showJumpToLatest: false,
        settleUntilMs: event.nowMs + policy.sessionSettleMs,
      };
    }

    case 'streaming-started': {
      if (state.mode === 'user-reading-history' || state.mode === 'restoring-anchor') return state;
      return {
        ...state,
        mode: 'pinned-to-bottom',
        atBottom: true,
      };
    }

    case 'content-changed': {
      return { ...state, messageCount: event.messageCount };
    }

    case 'user-scroll': {
      const atBottom = isNearBottom(event.metrics, policy.bottomThresholdPx);
      if (atBottom) {
        return {
          ...state,
          mode: 'pinned-to-bottom',
          atBottom: true,
          showJumpToLatest: false,
        };
      }
      return {
        ...state,
        mode: state.mode === 'restoring-anchor' ? 'restoring-anchor' : 'user-reading-history',
        atBottom: false,
        showJumpToLatest: true,
      };
    }

    case 'user-scroll-up': {
      return {
        ...state,
        mode: 'user-reading-history',
        atBottom: false,
        showJumpToLatest: true,
        settleUntilMs: 0,
        switchSettleUntilMs: 0,
      };
    }

    case 'jump-to-latest': {
      return {
        ...state,
        messageCount: event.messageCount,
        mode: 'pinned-to-bottom',
        atBottom: true,
        showJumpToLatest: false,
        settleUntilMs: event.nowMs + policy.jumpSettleMs,
      };
    }

    case 'jump-to-history': {
      return {
        ...state,
        mode: 'jumping',
        atBottom: false,
        showJumpToLatest: true,
        settleUntilMs: 0,
        switchSettleUntilMs: 0,
      };
    }

    case 'restore-anchor-start': {
      return {
        ...state,
        mode: 'restoring-anchor',
        atBottom: false,
        showJumpToLatest: true,
        settleUntilMs: 0,
        switchSettleUntilMs: 0,
      };
    }

    case 'restore-anchor-end': {
      const atBottom = isNearBottom(event.metrics, policy.bottomThresholdPx);
      return {
        ...state,
        mode: atBottom ? 'pinned-to-bottom' : 'user-reading-history',
        atBottom,
        showJumpToLatest: !atBottom,
      };
    }

    case 'compact-finished': {
      if (state.mode === 'user-reading-history' || state.mode === 'restoring-anchor') return state;
      return {
        ...state,
        mode: 'pinned-to-bottom',
        atBottom: true,
        settleUntilMs: event.nowMs + policy.compactSettleMs,
      };
    }
  }
}

/** True when new output/layout changes are allowed to move the viewport to bottom. */
export function shouldAutoFollowOutput(state: ScrollIntentState, nowMs: number): boolean {
  if (state.mode === 'user-reading-history' || state.mode === 'restoring-anchor' || state.mode === 'jumping') {
    return false;
  }
  return state.atBottom || nowMs < state.settleUntilMs || nowMs < state.switchSettleUntilMs;
}
