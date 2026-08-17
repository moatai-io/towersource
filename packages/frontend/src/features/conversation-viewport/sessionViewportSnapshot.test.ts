import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_VIEWPORT_PROJECTION_VERSION,
  captureSessionViewportSnapshot,
  chooseSessionViewportRestorePlan,
  clearAllSessionViewportSnapshots,
  getSessionViewportSnapshot,
  type ChatViewportSnapshot,
} from './sessionViewportSnapshot';

const historySnapshot: ChatViewportSnapshot = {
  anchorMessageId: 'm-2',
  anchorOffsetPx: -48,
  atBottom: false,
  capturedAt: 100,
  renderer: 'virtuoso',
  messageCountAtCapture: 3,
  projectionVersion: CHAT_VIEWPORT_PROJECTION_VERSION,
};

describe('sessionViewportSnapshot', () => {
  beforeEach(() => clearAllSessionViewportSnapshots());

  it('keeps stable-anchor snapshots in the current browser-tab session', () => {
    captureSessionViewportSnapshot('session-a', historySnapshot);
    expect(getSessionViewportSnapshot('session-a')).toEqual(historySnapshot);
  });

  it('restores a valid history anchor by stable message ID', () => {
    expect(chooseSessionViewportRestorePlan({
      snapshot: historySnapshot,
      messageIds: ['m-1', 'm-2', 'm-3'],
      hasExplicitMessageAnchor: false,
    })).toEqual({ kind: 'anchor', snapshot: historySnapshot, anchorIndex: 1 });
  });

  it('keeps bottom ownership when the tab was last at the latest message', () => {
    expect(chooseSessionViewportRestorePlan({
      snapshot: { ...historySnapshot, atBottom: true },
      messageIds: ['m-1', 'm-2', 'm-3'],
      hasExplicitMessageAnchor: false,
    })).toEqual({ kind: 'bottom', reason: 'snapshot-bottom' });
  });

  it('falls back safely when the anchor is outside the loaded window', () => {
    expect(chooseSessionViewportRestorePlan({
      snapshot: historySnapshot,
      messageIds: ['m-3'],
      hasExplicitMessageAnchor: false,
    })).toEqual({ kind: 'bottom', reason: 'anchor-missing' });
  });

  it('does not let a tab snapshot compete with an explicit URL anchor', () => {
    expect(chooseSessionViewportRestorePlan({
      snapshot: historySnapshot,
      messageIds: ['m-1', 'm-2'],
      hasExplicitMessageAnchor: true,
    })).toEqual({ kind: 'bottom', reason: 'invalid-snapshot' });
  });

  it('rejects snapshots from a different projection contract', () => {
    expect(chooseSessionViewportRestorePlan({
      snapshot: { ...historySnapshot, projectionVersion: 0 },
      messageIds: ['m-2'],
      hasExplicitMessageAnchor: false,
    })).toEqual({ kind: 'bottom', reason: 'invalid-snapshot' });
  });
});
