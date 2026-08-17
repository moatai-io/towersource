// Owns: coordinated frontend run-state mutations across session-store and chat-store.
// Public API: markSessionRunActive, markSessionRunAwaitingUser, markSessionRunQueued,
// markSessionRunWaitingRetry, markSessionRunFinished, markSessionRunIdle. See README.md.

import { useChatStore, type SessionTurnState, type TurnPhase } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';

type TurnMeta = Partial<Omit<SessionTurnState, 'phase'>>;

export interface MarkSessionRunFinishedOptions {
  /** Only paint a terminal phase when this tab actually observed streaming first. */
  onlyIfWasStreaming?: boolean;
}

/** Mark a session as actively running in both sidebar and turn-state planes. */
export function markSessionRunActive(sessionId: string, phase: TurnPhase = 'preparing', meta: TurnMeta = {}): void {
  useSessionStore.getState().setSessionStreaming(sessionId, true);
  useChatStore.getState().setTurnPhase(sessionId, phase, meta);
}

/** Mark a run as waiting on user input: no spinner, but keep explicit attention state. */
export function markSessionRunAwaitingUser(sessionId: string, pendingQuestionId?: string): void {
  useSessionStore.getState().setSessionStreaming(sessionId, false);
  useChatStore.getState().setTurnPhase(sessionId, 'awaiting_user', { pendingQuestionId });
}

/** Mark a session as queued/running in both sidebar and turn-state planes. */
export function markSessionRunQueued(sessionId: string, pendingMessageCount?: number): void {
  useSessionStore.getState().setSessionStreaming(sessionId, true);
  useChatStore.getState().setTurnPhase(sessionId, 'queued', { pendingMessageCount });
}

/** Restore a durable retry wait without presenting it as active streaming. */
export function markSessionRunWaitingRetry(sessionId: string, errorMessage?: string): void {
  useSessionStore.getState().setSessionStreaming(sessionId, false);
  useChatStore.getState().setTurnPhase(sessionId, 'queued', {
    pendingMessageCount: 1,
    errorMessage,
  });
}

/** Mark a session as no longer streaming and optionally paint a terminal turn phase. */
export function markSessionRunFinished(
  sessionId: string,
  phase: Extract<TurnPhase, 'done' | 'stopped' | 'error' | 'idle'> = 'done',
  meta: TurnMeta = {},
  options: MarkSessionRunFinishedOptions = {},
): boolean {
  const wasStreaming = useSessionStore.getState().streamingSessions.has(sessionId);
  useSessionStore.getState().setSessionStreaming(sessionId, false);
  if (!options.onlyIfWasStreaming || wasStreaming) {
    useChatStore.getState().setTurnPhase(sessionId, phase, meta);
  }
  return wasStreaming;
}

/** Clear stale running state without creating completion attention. */
export function markSessionRunIdle(sessionId: string, meta: TurnMeta = {}): void {
  useSessionStore.getState().setSessionStreaming(sessionId, false);
  useChatStore.getState().setTurnPhase(sessionId, 'idle', meta);
}
