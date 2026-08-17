import { describe, expect, it } from 'vitest';

import { selectNaturalLanguageSkillInvocation } from './skill-invocation.js';
import type { CommandEntry } from '../command-registry.js';

function skillCommand(overrides: Partial<CommandEntry> & { target: string }): CommandEntry {
  const canonical = `/${overrides.target}` as `/${string}`;
  return {
    id: overrides.target,
    kind: 'skill',
    canonical,
    name: canonical,
    aliases: [canonical],
    displayName: overrides.target,
    description: `${overrides.target} skill`,
    argumentHint: '',
    source: 'skills',
    scope: 'project',
    risk: 'medium',
    dispatch: { type: 'skill', target: overrides.target },
    ...overrides,
  } as CommandEntry;
}

describe('selectNaturalLanguageSkillInvocation', () => {
  it('invokes skill-architect for skill opportunity follow-up requests', () => {
    const invocation = selectNaturalLanguageSkillInvocation({
      message: [
        '1. Supabase Auth UX Doctor',
        '후보명: supabase-auth-ux-doctor',
        '무엇을 스킬화하나: 이메일 인증, 재전송, 로그인 실패 UX 점검',
        '이거 한번 해볼까',
      ].join('\n'),
      commands: [
        skillCommand({ target: 'meeting-prep', displayName: '회의 준비' }),
        skillCommand({ target: 'skill-architect', displayName: 'skill-architect' }),
      ],
    });

    expect(invocation).toMatchObject({
      skillName: 'skill-architect',
      trigger: 'natural-language',
      explicit: false,
    });
  });

  it('does not invoke skill-architect for a vague follow-up without skill context', () => {
    const invocation = selectNaturalLanguageSkillInvocation({
      message: '이거 한번 해볼까',
      commands: [skillCommand({ target: 'skill-architect', displayName: 'skill-architect' })],
    });

    expect(invocation).toBeNull();
  });
});
