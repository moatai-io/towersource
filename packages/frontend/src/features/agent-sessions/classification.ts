// Owns: frontend presentation classification for Agent Sessions and autonomous Task Runs.
// Public API: isPureAgentSession, isTaskRunSession, isDeploymentSession, getSessionPresentationKind.
// Keep Agent identity in sync with backend services/session/agent-session/ classification rules.

import type { SessionMeta } from '@tower/shared';

/**
 * True when the session is an agent backing session.
 *
 * This is a creation-time identity, not a conversation-state heuristic. Direct
 * human input may make an agent easier to discover, but must never reclassify its
 * backing session as a Chat. A normal parent Chat likewise remains a Chat when it
 * receives reports from one or many agents.
 */
export function isPureAgentSession(session: SessionMeta): boolean {
  return session.label === 'agent' || !!session.agent;
}

/** True for persisted sessions created by Task or schedule automation runs. */
export function isTaskRunSession(session: SessionMeta): boolean {
  return session.label === 'task';
}

/** True for conversations created by an externally deployed agent. */
export function isDeploymentSession(session: SessionMeta): boolean {
  return (session as unknown as { kind?: string }).kind === 'deployment' || session.label === '배포 세션';
}

/** Stable mutually-exclusive presentation kind used by sidebar and Latest filters. */
export function getSessionPresentationKind(session: SessionMeta): 'chat' | 'agent' | 'run' | 'deployment' {
  if (isPureAgentSession(session)) return 'agent';
  if (isTaskRunSession(session)) return 'run';
  if (isDeploymentSession(session)) return 'deployment';
  return 'chat';
}
