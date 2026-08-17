import { useChatStore } from '../stores/chat-store';
import { useSessionStore } from '../stores/session-store';

/**
 * Streaming-ish flag for the session currently shown in ChatPanel.
 *
 * Why not use only session-store.streamingSessions?
 * Pi turns can briefly transition through a frontend-only "done" phase after
 * session_status:idle arrives. If UI blocks (TodoWrite, tool chips, rich blocks)
 * key only off streamingSessions, they can collapse/flicker a beat too early.
 *
 * So for the ACTIVE chat session we treat these phases as still "live enough"
 * for rendering continuity: preparing, streaming, tool_running, compacting, done.
 */
export function useActiveSessionStreaming(): boolean {
  const sessionId = useChatStore((s) => s.sessionId);
  const turnPhase = useChatStore((s) => (sessionId ? s.turnStateBySession[sessionId]?.phase : 'idle'));
  const isSessionStreaming = useSessionStore((s) => (sessionId ? s.streamingSessions.has(sessionId) : false));

  if (!sessionId) return false;
  if (turnPhase === 'awaiting_user') return false;
  return isSessionStreaming || turnPhase === 'preparing' || turnPhase === 'streaming' || turnPhase === 'tool_running' || turnPhase === 'compacting' || turnPhase === 'done';
}
