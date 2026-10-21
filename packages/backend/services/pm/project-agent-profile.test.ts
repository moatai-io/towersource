import { describe, expect, it } from 'vitest';
import { buildProjectAgentRuntimePrompt, projectAgentProfileFromRow } from './project-agent-profile.js';

describe('projectAgentProfileFromRow', () => {
  it('derives an implicit primary agent for an existing project', () => {
    expect(projectAgentProfileFromRow({
      id: 'project-1',
      name: '회사소개서',
      description: '회사와 고객을 이해하는 업무공간',
      agent_profile_project_id: null,
    })).toMatchObject({
      id: 'project:project-1',
      kind: 'primary',
      projectId: 'project-1',
      displayName: '회사소개서',
      tagline: '회사와 고객을 이해하는 업무공간',
      instructionSource: 'agents-md',
      onboardingState: 'implicit',
      explicit: false,
    });
  });

  it('builds a bounded runtime identity block and mandatory intern operating policy for an active explicit profile', () => {
    const explicit = projectAgentProfileFromRow({
      id: 'project-2',
      name: 'fallback',
      agent_profile_project_id: 'project-2',
      agent_display_name: '전략 파트너',
      agent_face: '🧭',
      agent_role: '전략 담당자',
      agent_instruction: 'ignored by public mapper',
      agent_instruction_version: 3,
      agent_instruction_source: 'employee-card',
      agent_status: 'active',
    });
    const prompt = buildProjectAgentRuntimePrompt({ ...explicit, instruction: '사용자의 판단을 구조화합니다.' });
    expect(prompt).toContain('🧭 전략 파트너');
    expect(prompt).toContain('Profile version: 3');
    expect(prompt).toContain('사용자의 판단을 구조화합니다.');
    expect(prompt).toContain('Career Operating Policy: Intern');
    expect(prompt).toContain('Usually begin a new or materially unclear assignment with one useful question');
    expect(prompt).toContain('improving useful Project scaffolding');
    expect(prompt).toContain('Gather and organize the foundational source material');
    expect(prompt).toContain('Turn repeated or newly discovered work into a simple documented process');
    expect(prompt).toContain('Leave durable records for meaningful work');
    expect(prompt).toContain('AGENTS.md remains the canonical project operating context');
    expect(buildProjectAgentRuntimePrompt({ ...explicit, explicit: false, instruction: null })).toBe('');
  });

  it('does not apply the intern policy after promotion', () => {
    const explicit = projectAgentProfileFromRow({
      id: 'project-3',
      name: '실무자',
      agent_profile_project_id: 'project-3',
      agent_display_name: '실무자',
      agent_face: '🛠️',
      agent_instruction_version: 2,
      agent_instruction_source: 'employee-card',
      agent_status: 'active',
      agent_career_level: 'practitioner',
    });
    const prompt = buildProjectAgentRuntimePrompt({ ...explicit, instruction: '독립적으로 업무를 완수합니다.' });
    expect(prompt).not.toContain('Career Operating Policy: Intern');
    expect(prompt).not.toContain('Usually begin a new or materially unclear assignment with one useful question');
  });

  it('maps an explicit project primary-agent profile and policies', () => {
    expect(projectAgentProfileFromRow({
      id: 'project-2',
      name: 'fallback',
      agent_profile_project_id: 'project-2',
      agent_display_name: '전략 파트너',
      agent_face: '🧭',
      agent_tagline: '제품 방향을 계속 선명하게 합니다.',
      agent_instruction_version: 3,
      agent_instruction_source: 'employee-card',
      agent_default_engine: 'pi',
      agent_authority_policy: { tier: 'project-write' },
      agent_tool_policy: JSON.stringify({ canPublishExternal: false }),
      agent_onboarding_state: 'ready',
    })).toMatchObject({
      id: 'project:project-2',
      displayName: '전략 파트너',
      face: '🧭',
      profileVersion: 3,
      instructionSource: 'employee-card',
      defaultEngine: 'pi',
      authorityPolicy: { tier: 'project-write' },
      toolPolicy: { canPublishExternal: false },
      onboardingState: 'ready',
      explicit: true,
    });
  });
});
