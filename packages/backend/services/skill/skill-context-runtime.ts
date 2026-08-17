/**
 * Skill Context Runtime — turns an already-resolved SkillInvocation into the
 * model-visible active skill context for the current turn.
 *
 * Owns: active_skill prompt fragment shape, read-state metadata, and the
 * progressive-disclosure boundary between "skill was invoked" and "skill body
 * was loaded". Invocation detection stays in skill-invocation.ts.
 */

import type { SkillInvocation } from './skill-invocation.js';

export type ActiveSkillReadState = 'loaded' | 'missing';

export interface ActiveSkillContext {
  kind: 'active_skill';
  invocationId: string;
  skillName: string;
  trigger: SkillInvocation['trigger'];
  explicit: boolean;
  skillPath?: string;
  readState: ActiveSkillReadState;
  content: string;
  contentChars: number;
  prompt: string;
}

function activeSkillReadState(invocation: SkillInvocation): ActiveSkillReadState {
  return invocation.skillContent.trim().length > 0 ? 'loaded' : 'missing';
}

/** Build the active skill context fragment injected into the current model turn. */
export function buildActiveSkillContext(invocation: SkillInvocation): ActiveSkillContext {
  const readState = activeSkillReadState(invocation);
  const content = readState === 'loaded'
    ? invocation.skillContent
    : '(No SKILL.md content was available for this skill.)';
  const prompt = [
    `<active_skill name="${invocation.skillName}" read_state="${readState}">`,
    content,
    '</active_skill>',
    '',
    'The skill body above was selected for this turn by Tower\'s skill context runtime.',
    invocation.explicit
      ? 'The user explicitly invoked this skill.'
      : 'This skill was selected for the current user request.',
    `Trigger: ${invocation.trigger}`,
    `Original command: ${invocation.originalMessage}`,
    invocation.matchedAlias ? `Matched alias: ${invocation.matchedAlias}` : null,
    invocation.canonicalCommand ? `Canonical command: ${invocation.canonicalCommand}` : null,
    invocation.skillPath ? `Skill source: ${invocation.skillPath}` : null,
    `Arguments: ${invocation.args || '(none)'}`,
    '',
    'Follow the active skill instructions for this turn. Treat the arguments as the user request to perform through the skill.',
    'Do not assume unrelated skill references, scripts, or assets are loaded; discover and read only the resources needed for this turn.',
  ].filter((line): line is string => line !== null).join('\n');

  return {
    kind: 'active_skill',
    invocationId: invocation.id,
    skillName: invocation.skillName,
    trigger: invocation.trigger,
    explicit: invocation.explicit,
    skillPath: invocation.skillPath,
    readState,
    content,
    contentChars: invocation.skillContent.length,
    prompt,
  };
}

/** Metadata small enough to attach to messages/process events without leaking full SKILL.md bodies. */
export function activeSkillContextMetadata(context: ActiveSkillContext): Record<string, unknown> {
  return {
    kind: context.kind,
    invocationId: context.invocationId,
    skillName: context.skillName,
    trigger: context.trigger,
    explicit: context.explicit,
    readState: context.readState,
    contentChars: context.contentChars,
    skillPath: context.skillPath,
  };
}
