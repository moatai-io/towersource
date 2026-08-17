/**
 * Skill Invocation Runtime — turns skill activation signals into runnable context.
 *
 * Owns: normalized SkillInvocation objects, conservative natural-language matching,
 * active SKILL.md invocation metadata, and UI event payloads. Active skill prompt
 * rendering lives in skill-context-runtime.ts so invocation detection and context
 * loading stay separate.
 * Public API: createSkillInvocationFromCommand(), selectNaturalLanguageSkillInvocation(),
 * skillInvocationEventPayload().
 * See: workspace/decisions/2026-06-30-skill-invocation-runtime.md
 */

import { parseSlashInput, type CommandEntry, type ParsedSlashCommand } from '../command-registry.js';
import { buildActiveSkillContext } from './skill-context-runtime.js';

export type SkillInvocationTrigger = 'slash' | 'picker' | 'natural-language' | 'system';
export type SkillInvocationSource = 'project' | 'company' | 'managed' | 'runtime-box' | 'system';

export interface SkillInvocation {
  id: string;
  skillName: string;
  displayName?: string;
  trigger: SkillInvocationTrigger;
  source: SkillInvocationSource;
  matchedAlias?: string;
  canonicalCommand?: `/${string}`;
  originalMessage: string;
  args: string;
  skillContent: string;
  skillPath?: string;
  explicit: boolean;
}

function normalizeInvocationSource(source: CommandEntry['scope'] | string | undefined): SkillInvocationSource {
  if (source === 'project') return 'project';
  if (source === 'company') return 'company';
  if (source === 'system') return 'system';
  return 'managed';
}

export function createSkillInvocationFromCommand(args: {
  command: CommandEntry;
  matchedAlias?: string;
  originalMessage: string;
  skillArgs: string;
  trigger?: SkillInvocationTrigger;
}): SkillInvocation {
  const skillName = args.command.dispatch.target || args.command.canonical.replace(/^\//, '');
  return {
    id: `${args.trigger || 'slash'}:${skillName}`,
    skillName,
    displayName: args.command.displayName,
    trigger: args.trigger || 'slash',
    source: normalizeInvocationSource(args.command.scope),
    matchedAlias: args.matchedAlias,
    canonicalCommand: args.command.canonical,
    originalMessage: args.originalMessage,
    args: args.skillArgs,
    skillContent: args.command.fullContent || '',
    explicit: (args.trigger || 'slash') !== 'natural-language',
  };
}

function naturalLanguageKey(value: string): string {
  return value
    .replace(/^\/+/, '')
    .toLocaleLowerCase()
    .replace(/[\s_\-]+/g, '');
}

function naturalLanguageLabels(command: CommandEntry): Array<{ raw: string; key: string }> {
  const values = [
    command.dispatch.target,
    command.name,
    command.canonical,
    ...(command.aliases || []),
    command.displayName,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const seen = new Set<string>();
  return values.flatMap((raw) => {
    const stripped = raw.replace(/^\/+/, '').trim();
    const key = naturalLanguageKey(stripped);
    if (!key || key.length < 3 || seen.has(key)) return [];
    seen.add(key);
    return [{ raw: stripped, key }];
  });
}

function isConservativeNaturalLanguageMatch(message: string, label: { raw: string; key: string }): boolean {
  const raw = message.trim();
  if (!raw || raw.startsWith('/')) return false;
  const msgKey = naturalLanguageKey(raw);
  if (!msgKey.includes(label.key)) return false;

  // High precision gates only. We do not auto-trigger merely because a common
  // word appears in the request; the user must either name the skill up front or
  // explicitly say they want to use that skill.
  const startsWithLabel = msgKey.startsWith(label.key);
  const mentionsAsSkill = msgKey.includes(`${label.key}스킬`) || msgKey.includes(`${label.key}skill`);
  const saysUse = /(스킬|skill).*(써|사용|발동|invoke|use)/i.test(raw) && msgKey.includes(label.key);
  return startsWithLabel || mentionsAsSkill || saysUse;
}

function isSkillArchitectCommand(command: CommandEntry): boolean {
  const values = [command.dispatch.target, command.name, command.canonical, command.displayName]
    .filter((value): value is string => typeof value === 'string');
  return values.some((value) => naturalLanguageKey(value) === 'skillarchitect');
}

function isSkillOpportunityFollowUp(message: string): boolean {
  const raw = message.trim();
  if (!raw || raw.startsWith('/')) return false;

  const hasSkillOpportunityContext = /스킬화|스킬\s*후보|후보명|Agent\s*Skill|skill\s*(candidate|opportunity)|repeatable\s+skill/i.test(raw);
  if (!hasSkillOpportunityContext) return false;

  return /해볼까|해보자|진행|만들어|만들자|작성|스캐폴드|create|build|scaffold/i.test(raw);
}

export function selectNaturalLanguageSkillInvocation(args: {
  message: string;
  commands: CommandEntry[];
}): SkillInvocation | null {
  const candidates = args.commands.filter((command) =>
    command.dispatch.type === 'skill' &&
    (command.risk === 'low' || command.risk === 'medium')
  );
  const matches = candidates.flatMap((command) => {
    const labels = naturalLanguageLabels(command);
    const match = labels.find((label) => isConservativeNaturalLanguageMatch(args.message, label));
    return match ? [{ command, match }] : [];
  });
  if (matches.length === 0 && isSkillOpportunityFollowUp(args.message)) {
    const skillArchitect = candidates.find(isSkillArchitectCommand);
    if (skillArchitect) {
      return createSkillInvocationFromCommand({
        command: skillArchitect,
        originalMessage: args.message,
        skillArgs: args.message,
        trigger: 'natural-language',
      });
    }
  }
  if (matches.length !== 1) return null;
  return createSkillInvocationFromCommand({
    command: matches[0].command,
    matchedAlias: matches[0].match.raw.startsWith('/') ? matches[0].match.raw as `/${string}` : undefined,
    originalMessage: args.message,
    skillArgs: args.message,
    trigger: 'natural-language',
  });
}

export function resolveSkillInvocationForMessage(args: {
  message: string;
  commands: CommandEntry[];
  commandTrigger?: SkillInvocationTrigger;
}): { parsedSlash: ParsedSlashCommand | null; invocation: SkillInvocation | null } {
  const parsedSlash = parseSlashInput(args.message, args.commands);
  if (parsedSlash?.command.dispatch.type === 'skill') {
    return {
      parsedSlash,
      invocation: createSkillInvocationFromCommand({
        command: parsedSlash.command,
        matchedAlias: parsedSlash.matchedAlias,
        skillArgs: parsedSlash.args,
        originalMessage: args.message,
        trigger: args.commandTrigger === 'picker' ? 'picker' : 'slash',
      }),
    };
  }
  if (args.commandTrigger === 'natural-language' || !parsedSlash) {
    return {
      parsedSlash,
      invocation: selectNaturalLanguageSkillInvocation({
        message: args.message,
        commands: args.commands,
      }),
    };
  }
  return { parsedSlash, invocation: null };
}

export function mergeSkillInvocationMetadata<T extends Record<string, any>>(
  metadata: T,
  invocation: SkillInvocation | null | undefined,
): T & { skillInvocation?: Record<string, unknown> } {
  return invocation
    ? { ...metadata, skillInvocation: skillInvocationMetadata(invocation) }
    : metadata;
}

export function skillInvocationProcessEventParams(args: {
  projectId?: string | null;
  sessionId: string;
  invocation: SkillInvocation;
  phase?: 'started' | 'loaded' | 'completed' | 'failed';
  assistantMessageIds?: string[];
  error?: string;
}): {
  projectId?: string | null;
  sessionId: string;
  sourceType: 'skill_invocation';
  sourceId: string;
  eventType: 'step_started' | 'step_completed' | 'step_failed';
  rawLabel: string;
  rawPayload: Record<string, unknown>;
} {
  const phase = args.phase || 'started';
  const eventType = phase === 'completed'
    ? 'step_completed'
    : phase === 'failed'
      ? 'step_failed'
      : 'step_started';
  const labelVerb = phase === 'completed'
    ? 'completed'
    : phase === 'failed'
      ? 'failed'
      : phase === 'loaded'
        ? 'loaded'
        : 'started';
  return {
    projectId: args.projectId ?? null,
    sessionId: args.sessionId,
    sourceType: 'skill_invocation',
    sourceId: args.invocation.id,
    eventType,
    rawLabel: `Skill ${labelVerb}: ${args.invocation.displayName || args.invocation.skillName}`,
    rawPayload: {
      ...skillInvocationMetadata(args.invocation),
      phase,
      assistantMessageIds: args.assistantMessageIds,
      error: args.error,
    },
  };
}

/** @deprecated Use buildActiveSkillContext(invocation).prompt instead. */
export function renderSkillInvocationPrompt(invocation: SkillInvocation): string {
  return buildActiveSkillContext(invocation).prompt;
}

export function skillInvocationMetadata(invocation: SkillInvocation): Record<string, unknown> {
  return {
    id: invocation.id,
    skillName: invocation.skillName,
    displayName: invocation.displayName || invocation.skillName,
    trigger: invocation.trigger,
    matchedAlias: invocation.matchedAlias,
    canonicalCommand: invocation.canonicalCommand,
    source: invocation.source,
    explicit: invocation.explicit,
  };
}

export function skillInvocationEventPayload(sessionId: string, invocation: SkillInvocation): Record<string, unknown> {
  return {
    type: 'skill_invoked',
    sessionId,
    invocationId: invocation.id,
    skillName: invocation.skillName,
    displayName: invocation.displayName || invocation.skillName,
    trigger: invocation.trigger,
    matchedAlias: invocation.matchedAlias,
    source: invocation.source,
    explicit: invocation.explicit,
    message: `${invocation.displayName || invocation.skillName} 스킬을 사용합니다.`,
  };
}
