import { describe, expect, it } from 'vitest';
import {
  agentCareerPoints,
  agentCareerProgress,
  deriveAgentCareerLevel,
  highestAgentCareerLevel,
  nextAgentCareerStage,
} from './agent-career';

describe('agent career invariant', () => {
  it('never skips the next stage when showing progress', () => {
    expect(nextAgentCareerStage('intern')?.level).toBe('practitioner');
    expect(nextAgentCareerStage('practitioner')?.level).toBe('manager');
    expect(nextAgentCareerStage('manager')?.level).toBe('partner');
    expect(nextAgentCareerStage('partner')).toBeNull();
  });

  it('derives a career from completed work and any successful Skill use', () => {
    expect(agentCareerPoints({ completedWorkstreams: 2, successfulSkillInvocations: 9 })).toBe(29);
    expect(deriveAgentCareerLevel({ completedWorkstreams: 2, successfulSkillInvocations: 9 })).toBe('intern');
    expect(deriveAgentCareerLevel({ completedWorkstreams: 3, successfulSkillInvocations: 0 })).toBe('practitioner');
    expect(deriveAgentCareerLevel({ completedWorkstreams: 8, successfulSkillInvocations: 20 })).toBe('manager');
    expect(deriveAgentCareerLevel({ completedWorkstreams: 25, successfulSkillInvocations: 0 })).toBe('partner');
  });

  it('does not require an Agent to create its own Skill', () => {
    expect(agentCareerProgress('practitioner', { completedWorkstreams: 9, successfulSkillInvocations: 9 }).eligible).toBe(false);
    expect(agentCareerProgress('practitioner', { completedWorkstreams: 9, successfulSkillInvocations: 10 }).eligible).toBe(true);
  });

  it('keeps the highest previously earned level to prevent automatic demotion', () => {
    expect(highestAgentCareerLevel('manager', deriveAgentCareerLevel({ completedWorkstreams: 0, successfulSkillInvocations: 0 }))).toBe('manager');
    expect(highestAgentCareerLevel('intern', deriveAgentCareerLevel({ completedWorkstreams: 25, successfulSkillInvocations: 0 }))).toBe('partner');
  });
});
