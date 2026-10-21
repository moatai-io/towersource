import { create } from 'zustand';

/** Ephemeral UI only: never persisted as conversation messages or run outcomes. */
export const useChatFeedback = create<{
  connected: boolean;
  requests: Record<string, boolean>;
}>(() => ({ connected: true, requests: {} }));

export function setChatConnection(connected: boolean) {
  useChatFeedback.setState(connected ? { connected, requests: {} } : { connected });
}

export function reportChatRequestFailure(sessionId: string | null) {
  // Unscoped transport errors cannot prove that a turn failed. Never mutate runs.
  if (!sessionId || !useChatFeedback.getState().connected) return;
  useChatFeedback.setState(s => ({ requests: { ...s.requests, [sessionId]: true } }));
}

export function dismissChatRequestFailure(sessionId: string) {
  useChatFeedback.setState(s => {
    const requests = { ...s.requests };
    delete requests[sessionId];
    return { requests };
  });
}
