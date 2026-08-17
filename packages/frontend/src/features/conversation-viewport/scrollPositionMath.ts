/**
 * Owns: Pure scroll-position calculations for conversation viewport stability.
 * Public API: isNearBottom, bottomScrollTop, restorePrependScrollTop.
 * See README.md.
 */

import type { PrependAnchorSnapshot, ViewportMetrics } from './viewportTypes';

/** Return the valid bottom scrollTop for the current geometry. */
export function bottomScrollTop(metrics: Pick<ViewportMetrics, 'scrollHeight' | 'clientHeight'>): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

/** True when the viewport is close enough to the bottom to auto-follow new output. */
export function isNearBottom(metrics: ViewportMetrics, thresholdPx: number): boolean {
  return bottomScrollTop(metrics) - metrics.scrollTop <= thresholdPx;
}

/** Clamp a scrollTop so caller code never writes an impossible DOM position. */
export function clampScrollTop(scrollTop: number, metrics: Pick<ViewportMetrics, 'scrollHeight' | 'clientHeight'>): number {
  return Math.max(0, Math.min(bottomScrollTop(metrics), scrollTop));
}

/**
 * Preserve the user's viewport after older messages are prepended above it.
 *
 * If the scrollHeight grew by 1,200px while the old scrollTop was 300px, the
 * equivalent visual anchor is now at 1,500px. This is the plain DOM sibling of
 * Virtuoso's scrollToIndex(anchor) restoration path.
 */
export function restorePrependScrollTop(
  before: PrependAnchorSnapshot,
  after: Pick<ViewportMetrics, 'scrollHeight' | 'clientHeight'>,
): number {
  const delta = Math.max(0, after.scrollHeight - before.scrollHeight);
  return clampScrollTop(before.scrollTop + delta, after);
}
