/**
 * Command Invocation Runtime — normalized process telemetry for slash commands.
 *
 * Owns: lightweight CommandInvocation objects and process-event payloads for
 * user-facing `/...` command execution. Skill-specific active context remains in
 * skill-invocation.ts / skill-context-runtime.ts.
 * Public API: createCommandInvocationFromParsed(), commandInvocationProcessEventParams().
 * See: workspace/decisions/2026-06-30-command-as-user-facing-interface.md
 */

import type { CommandEntry, ParsedSlashCommand } from './command-registry.js';

export type CommandInvocationTrigger = 'slash' | 'picker' | 'system';

export interface CommandInvocation {
  id: string;
  commandId: string;
  commandKind: CommandEntry['kind'];
  displayName?: string;
  canonicalCommand: `/${string}`;
  matchedAlias: `/${string}`;
  args: string;
  trigger: CommandInvocationTrigger;
  source: CommandEntry['source'];
  scope: CommandEntry['scope'];
  dispatch: CommandEntry['dispatch'];
  uiAction?: CommandEntry['uiAction'];
  originalMessage: string;
}

export function createCommandInvocationFromParsed(args: {
  parsed: ParsedSlashCommand;
  originalMessage: string;
  trigger?: CommandInvocationTrigger;
}): CommandInvocation {
  const { command } = args.parsed;
  return {
    id: `${args.trigger || 'slash'}:${command.id}`,
    commandId: command.id,
    commandKind: command.kind,
    displayName: command.displayName,
    canonicalCommand: command.canonical,
    matchedAlias: args.parsed.matchedAlias,
    args: args.parsed.args,
    trigger: args.trigger || 'slash',
    source: command.source,
    scope: command.scope,
    dispatch: command.dispatch,
    uiAction: command.uiAction,
    originalMessage: args.originalMessage,
  };
}

export function commandInvocationMetadata(invocation: CommandInvocation): Record<string, unknown> {
  return {
    id: invocation.id,
    commandId: invocation.commandId,
    commandKind: invocation.commandKind,
    displayName: invocation.displayName || invocation.canonicalCommand,
    canonicalCommand: invocation.canonicalCommand,
    matchedAlias: invocation.matchedAlias,
    args: invocation.args,
    trigger: invocation.trigger,
    source: invocation.source,
    scope: invocation.scope,
    dispatch: invocation.dispatch,
    uiAction: invocation.uiAction,
  };
}

export function commandInvocationProcessEventParams(args: {
  projectId?: string | null;
  sessionId: string;
  invocation: CommandInvocation;
  phase?: 'started' | 'completed' | 'failed';
  error?: string;
}): {
  projectId?: string | null;
  sessionId: string;
  sourceType: 'command_invocation';
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
  const label = args.invocation.displayName || args.invocation.canonicalCommand;
  return {
    projectId: args.projectId ?? null,
    sessionId: args.sessionId,
    sourceType: 'command_invocation',
    sourceId: args.invocation.id,
    eventType,
    rawLabel: `Command ${phase}: ${label}`,
    rawPayload: {
      ...commandInvocationMetadata(args.invocation),
      phase,
      error: args.error,
    },
  };
}
