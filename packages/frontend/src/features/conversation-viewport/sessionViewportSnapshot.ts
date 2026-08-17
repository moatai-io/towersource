/**
 * Owns: In-memory reading-position snapshots for open chat sessions.
 * Public API: ChatViewportSnapshot, capture/get/clearSessionViewportSnapshot, chooseSessionViewportRestorePlan.
 * See README.md.
 */

export const CHAT_VIEWPORT_PROJECTION_VERSION = 1;

export type ChatViewportRenderer = 'plain' | 'virtuoso';

export interface ChatViewportSnapshot {
  anchorMessageId: string | null;
  anchorOffsetPx: number;
  atBottom: boolean;
  capturedAt: number;
  renderer: ChatViewportRenderer;
  messageCountAtCapture: number;
  projectionVersion: number;
}

export type SessionViewportRestorePlan =
  | { kind: 'bottom'; reason: 'first-open' | 'snapshot-bottom' | 'invalid-snapshot' | 'anchor-missing' }
  | { kind: 'anchor'; snapshot: ChatViewportSnapshot; anchorIndex: number };

// sessionStorage is current-browser-tab scoped: it survives Vite HMR and a page
// reload, but does not carry stale layout state into a future browser session.
// We store stable message anchors only — never Virtuoso measurements or scrollTop.
const SESSION_STORAGE_KEY = 'tower:chatViewportSnapshots:v1';
const snapshotsBySession = new Map<string, ChatViewportSnapshot>();
let hydrated = false;

function hydrateSnapshots(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof sessionStorage === 'undefined') return;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || '{}') as Record<string, ChatViewportSnapshot>;
    for (const [sessionId, snapshot] of Object.entries(parsed)) {
      if (snapshot?.projectionVersion === CHAT_VIEWPORT_PROJECTION_VERSION) snapshotsBySession.set(sessionId, snapshot);
    }
  } catch {}
}

function persistSnapshots(): void {
  if (typeof sessionStorage === 'undefined') return;
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(Object.fromEntries(snapshotsBySession))); } catch {}
}

/** Save the latest stable viewport anchor for an open chat session. */
export function captureSessionViewportSnapshot(sessionId: string, snapshot: ChatViewportSnapshot): void {
  hydrateSnapshots();
  snapshotsBySession.set(sessionId, snapshot);
  persistSnapshots();
}

/** Read the current-browser-tab snapshot for a chat session. */
export function getSessionViewportSnapshot(sessionId: string): ChatViewportSnapshot | undefined {
  hydrateSnapshots();
  return snapshotsBySession.get(sessionId);
}

/** Remove one session snapshot when its open-tab lifecycle ends. */
export function clearSessionViewportSnapshot(sessionId: string): void {
  hydrateSnapshots();
  snapshotsBySession.delete(sessionId);
  persistSnapshots();
}

/** Remove all snapshots. Exported for deterministic tests. */
export function clearAllSessionViewportSnapshots(): void {
  hydrateSnapshots();
  snapshotsBySession.clear();
  persistSnapshots();
}

/**
 * Choose one final target before any DOM writer runs.
 * Explicit URL anchors are handled by ChatPanel and therefore disable tab restoration.
 */
export function chooseSessionViewportRestorePlan({
  snapshot,
  messageIds,
  hasExplicitMessageAnchor,
}: {
  snapshot?: ChatViewportSnapshot;
  messageIds: string[];
  hasExplicitMessageAnchor: boolean;
}): SessionViewportRestorePlan {
  if (hasExplicitMessageAnchor) return { kind: 'bottom', reason: 'invalid-snapshot' };
  if (!snapshot) return { kind: 'bottom', reason: 'first-open' };
  if (snapshot.projectionVersion !== CHAT_VIEWPORT_PROJECTION_VERSION) {
    return { kind: 'bottom', reason: 'invalid-snapshot' };
  }
  if (snapshot.atBottom) return { kind: 'bottom', reason: 'snapshot-bottom' };
  if (!snapshot.anchorMessageId || !Number.isFinite(snapshot.anchorOffsetPx)) {
    return { kind: 'bottom', reason: 'invalid-snapshot' };
  }
  const anchorIndex = messageIds.indexOf(snapshot.anchorMessageId);
  if (anchorIndex < 0) return { kind: 'bottom', reason: 'anchor-missing' };
  return { kind: 'anchor', snapshot, anchorIndex };
}
