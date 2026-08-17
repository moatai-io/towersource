/**
 * Owns: Shared types for the conversation viewport engine.
 * Public API: ScrollIntentMode, ScrollIntentState, ViewportMetrics, PrependAnchorSnapshot.
 * See README.md.
 */

/** User-vs-app ownership mode for the chat viewport. */
export type ScrollIntentMode =
  | 'pinned-to-bottom'
  | 'user-reading-history'
  | 'jumping'
  | 'restoring-anchor';

/** Minimal, serializable scroll state; keep DOM/Virtuoso objects out of this layer. */
export interface ScrollIntentState {
  mode: ScrollIntentMode;
  atBottom: boolean;
  showJumpToLatest: boolean;
  settleUntilMs: number;
  switchSettleUntilMs: number;
  activeSessionId: string | null;
  messageCount: number;
}

/** Raw scroll geometry captured from the active scroller. */
export interface ViewportMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Snapshot captured immediately before prepending older messages. */
export interface PrependAnchorSnapshot {
  scrollTop: number;
  scrollHeight: number;
}

/** Tunable policy thresholds for scroll intent decisions. */
export interface ScrollIntentPolicy {
  bottomThresholdPx: number;
  sessionSettleMs: number;
  jumpSettleMs: number;
  compactSettleMs: number;
}

export const DEFAULT_SCROLL_INTENT_POLICY: ScrollIntentPolicy = {
  bottomThresholdPx: 80,
  sessionSettleMs: 2_000,
  jumpSettleMs: 1_000,
  compactSettleMs: 800,
};
