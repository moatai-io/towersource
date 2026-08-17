export type ScrollDebugEventName =
  | 'session-settle'
  | 'messages-loaded'
  | 'streaming-started'
  | 'compact-finished'
  | 'scroll-generation'
  | 'jump-history'
  | 'jump-latest'
  | 'start-reached'
  | 'anchor-restore'
  | 'range-changed'
  | 'visible-range-dom'
  | 'user-scroll-up'
  | 'at-bottom-change'
  | 'snapshot-before-switch'
  | 'restore-requested'
  | 'restore-fallback'
  | 'restore-applied';

export type ScrollDebugPayload = Record<string, unknown>;

type ScrollDebugEntry = {
  at: number;
  event: ScrollDebugEventName;
  payload?: ScrollDebugPayload;
};

const FLAG_KEY = 'tower.chatScrollDebug';
const BUFFER_KEY = '__towerChatScrollDebug';
const MAX_ENTRIES = 200;

declare global {
  interface Window {
    __towerChatScrollDebug?: ScrollDebugEntry[];
  }
}

/**
 * Opt-in chat scroll trace for flicker investigations.
 * Enable in browser console: localStorage.setItem('tower.chatScrollDebug', '1')
 */
export function traceChatScroll(event: ScrollDebugEventName, payload?: ScrollDebugPayload) {
  if (typeof window === 'undefined') return;
  if (window.localStorage?.getItem(FLAG_KEY) !== '1') return;

  const entry: ScrollDebugEntry = { at: performance.now(), event, payload };
  const buffer = window.__towerChatScrollDebug ?? [];
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  window.__towerChatScrollDebug = buffer;

  // Keep console output compact enough to correlate with visible flicker.
  // eslint-disable-next-line no-console
  console.debug('[chat-scroll]', event, payload ?? {});
}

/** Returns the in-memory scroll trace buffer for manual browser inspection. */
export function getChatScrollTrace(): ScrollDebugEntry[] {
  if (typeof window === 'undefined') return [];
  return window.__towerChatScrollDebug ?? [];
}

/** Clears the in-memory scroll trace buffer. */
export function clearChatScrollTrace() {
  if (typeof window === 'undefined') return;
  window.__towerChatScrollDebug = [];
}

export { FLAG_KEY as CHAT_SCROLL_DEBUG_FLAG_KEY };
