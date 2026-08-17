/**
 * Owns: concrete Primary Agent resolution for channel invocation.
 * Public API: resolveChannelAgent(). See README.md.
 */
import { getProject } from '../pm/project-manager.js';
import { buildProjectAgentRuntimePrompt, getProjectAgentRuntimeProfile } from '../pm/project-agent-profile.js';

export interface ResolvedChannelAgent {
  projectId: string;
  projectName: string;
  displayName: string;
  face: string;
  rootPath: string | undefined;
  description: string | undefined;
  engine: string;
  model: string | null;
  identityPrompt: string;
}

/**
 * Resolve an invited Primary Agent's published identity/runtime profile.
 * Invitation is the channel-level call grant; it does not expose Agent Project files.
 */
export async function resolveChannelAgent(input: {
  agentProjectId: string;
  userId: number;
  userRole: string;
  fallbackEngine: string;
  fallbackModel: string;
}): Promise<ResolvedChannelAgent> {
  const [project, profile] = await Promise.all([
    getProject(input.agentProjectId),
    getProjectAgentRuntimeProfile(input.agentProjectId),
  ]);
  if (!project) throw new Error('Agent Project not found');
  if (!profile || !['active', 'ready'].includes(profile.status)) {
    throw new Error('Agent is not available');
  }

  return {
    projectId: input.agentProjectId,
    projectName: project.name,
    displayName: profile.displayName,
    face: profile.face,
    rootPath: project.rootPath || undefined,
    description: project.description || undefined,
    engine: profile.defaultEngine || input.fallbackEngine,
    model: profile.defaultModel || input.fallbackModel,
    identityPrompt: buildProjectAgentRuntimePrompt(profile),
  };
}
