import { useChatStore, type SessionTurnState } from '../stores/chat-store';

const IDLE_STATE: SessionTurnState = {
  phase: 'idle',
  startedAt: null,
  lastActivityAt: null,
  pendingMessageCount: 0,
};

export function useActiveSessionTurnState(): SessionTurnState {
  const sessionId = useChatStore((s) => s.sessionId);
  return useChatStore((s) => (sessionId ? (s.turnStateBySession[sessionId] || IDLE_STATE) : IDLE_STATE));
}
