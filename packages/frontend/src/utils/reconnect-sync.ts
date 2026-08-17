export interface ReconnectSyncInput {
  sessionId: string | null;
  claudeSessionId: string | null;
}

export interface ReconnectSyncPlan {
  wsMessages: Array<Record<string, unknown>>;
  refetchSessions: boolean;
  refetchActiveSessionMessages: string | null;
}

export function buildReconnectSyncPlan(input: ReconnectSyncInput): ReconnectSyncPlan {
  const wsMessages: Array<Record<string, unknown>> = [];

  if (input.sessionId) {
    wsMessages.push({
      type: 'reconnect',
      sessionId: input.sessionId,
      claudeSessionId: input.claudeSessionId || undefined,
    });
  }

  wsMessages.push({ type: 'task_list' });

  return {
    wsMessages,
    refetchSessions: true,
    refetchActiveSessionMessages: input.sessionId,
  };
}
