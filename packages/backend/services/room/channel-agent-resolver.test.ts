import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getProject, getProfile, buildPrompt } = vi.hoisted(() => ({
  getProject: vi.fn(),
  getProfile: vi.fn(),
  buildPrompt: vi.fn(),
}));
vi.mock('../pm/project-manager.js', () => ({ getProject }));
vi.mock('../pm/project-agent-profile.js', () => ({
  getProjectAgentRuntimeProfile: getProfile,
  buildProjectAgentRuntimePrompt: buildPrompt,
}));

import { resolveChannelAgent } from './channel-agent-resolver.js';

describe('resolveChannelAgent invitation contract', () => {
  beforeEach(() => {
    getProject.mockReset();
    getProfile.mockReset();
    buildPrompt.mockReset();
  });

  it('resolves a published Agent profile without requiring the caller to join its Project', async () => {
    getProject.mockResolvedValue({ id: 'agent-p', name: 'Research Agent', rootPath: '/workspace/projects/agent-p', description: 'research' });
    getProfile.mockResolvedValue({ status: 'active', displayName: '리서처', face: '🔎', defaultEngine: 'pi', defaultModel: 'model-x' });
    buildPrompt.mockReturnValue('identity');

    await expect(resolveChannelAgent({
      agentProjectId: 'agent-p',
      userId: 22,
      userRole: 'guest',
      fallbackEngine: 'claude',
      fallbackModel: 'fallback',
    })).resolves.toMatchObject({ projectId: 'agent-p', displayName: '리서처', identityPrompt: 'identity' });
  });

  it('still fails closed for an unavailable Agent profile', async () => {
    getProject.mockResolvedValue({ id: 'agent-p', name: 'Agent' });
    getProfile.mockResolvedValue({ status: 'draft' });
    await expect(resolveChannelAgent({
      agentProjectId: 'agent-p', userId: 1, userRole: 'member', fallbackEngine: 'pi', fallbackModel: 'm',
    })).rejects.toThrow('not available');
  });
});
