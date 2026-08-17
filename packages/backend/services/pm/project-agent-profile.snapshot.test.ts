import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const execute = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ queryOne, execute }));

const { getDisabledSkillsForAgentProfile, getSessionProjectAgentRuntimeProfile, repinSessionProjectAgentProfile } = await import('./project-agent-profile.js');

const profileRow = (version: number, instruction: string) => ({
  id: 'project-1', name: '전략팀', description: '전략 업무',
  agent_profile_project_id: 'project-1', agent_display_name: '전략 파트너', agent_face: '🧭',
  agent_instruction: instruction, agent_instruction_version: version,
  agent_instruction_source: 'employee-card', agent_status: 'active', agent_onboarding_state: 'ready',
});

beforeEach(() => { queryOne.mockReset(); execute.mockReset(); });

describe('Session Project Agent profile snapshot', () => {
  it('returns the pinned snapshot instead of a newer Project profile', async () => {
    queryOne.mockResolvedValueOnce({ project_agent_profile_snapshot: {
      id: 'project:project-1', kind: 'primary', projectId: 'project-1', displayName: '전략 파트너', face: '🧭',
      profileVersion: 2, instructionSource: 'employee-card', instruction: 'v2 지침', toolPolicy: { disabledSkills: ['web-capture'] }, status: 'active', onboardingState: 'ready', explicit: true,
    }});
    const profile = await getSessionProjectAgentRuntimeProfile('session-1', 'project-1');
    expect(profile).toMatchObject({ profileVersion: 2, instruction: 'v2 지침', toolPolicy: { disabledSkills: ['web-capture'] } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('pins the latest explicit profile once for a legacy Session', async () => {
    queryOne
      .mockResolvedValueOnce({ project_agent_profile_snapshot: null })
      .mockResolvedValueOnce(profileRow(3, 'v3 지침'))
      .mockResolvedValueOnce({ project_agent_profile_snapshot: {
        id: 'project:project-1', kind: 'primary', projectId: 'project-1', displayName: '전략 파트너', face: '🧭',
        profileVersion: 3, instructionSource: 'employee-card', instruction: 'v3 지침', status: 'active', onboardingState: 'ready', explicit: true,
      }});
    const profile = await getSessionProjectAgentRuntimeProfile('session-1', 'project-1');
    expect(profile?.profileVersion).toBe(3);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('project_agent_profile_snapshot IS NULL'), expect.any(Array));
  });

  it('reads the Primary Agent disabled skill policy from the pinned profile', () => {
    expect(Array.from(getDisabledSkillsForAgentProfile({ toolPolicy: { disabledSkills: ['web-capture', ' web-capture ', 3] } } as any)))
      .toEqual(['web-capture']);
  });

  it('repins only when explicitly requested', async () => {
    queryOne.mockResolvedValueOnce(profileRow(5, 'v5 지침'));
    const profile = await repinSessionProjectAgentProfile('session-1', 'project-1');
    expect(profile?.profileVersion).toBe(5);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('project_agent_profile_pinned_at = NOW()'), expect.any(Array));
  });
});
