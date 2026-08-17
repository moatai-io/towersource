import type { Project } from '@tower/shared';
import type { SessionMeta } from './stores/session-store';

export type AgentFirstStartupDecision =
  | { kind: 'none' }
  | { kind: 'open-agent-creator'; project: Project };

/**
 * True first-time users open the teammate creator directly. The legacy
 * ai-talent-team system Project is only a hidden approval/seed context here;
 * no helper conversation is created.
 */
export function decideAgentFirstStartup(input: {
  agentFirstEnabled: boolean;
  sessions: SessionMeta[];
  projects: Project[];
}): AgentFirstStartupDecision {
  if (!input.agentFirstEnabled || input.sessions.length > 0) return { kind: 'none' };
  const project = input.projects.find((candidate) => candidate.systemKey === 'ai-talent-team');
  return project ? { kind: 'open-agent-creator', project } : { kind: 'none' };
}
