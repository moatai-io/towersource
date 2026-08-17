import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { getCommandsForUser } from '../services/skill/skill-registry.js';
import type { CommandEntry } from '../services/command-registry.js';

export interface PiSkillToolContext {
  userId?: number;
  username?: string;
  projectId?: string;
  cwd?: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError, details: undefined };
}

function commandAliasMatches(command: CommandEntry, name: string): boolean {
  const normalized = name.trim().replace(/^\//, '').toLocaleLowerCase();
  const values = [command.name, command.canonical, ...(command.aliases || []), command.dispatch.target]
    .filter(Boolean)
    .map((value) => String(value).replace(/^\//, '').toLocaleLowerCase());
  return values.includes(normalized);
}

function summarizeSkill(command: CommandEntry) {
  return {
    name: command.dispatch.target || command.name,
    canonical: command.canonical,
    aliases: command.aliases || [],
    displayName: command.displayName || command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    scope: command.scope,
    source: command.source,
    risk: command.risk,
  };
}

export function createSkillsListTool(ctx: PiSkillToolContext): ToolDefinition {
  return ({
    name: 'skills_list',
    label: 'List Skills',
    description: 'List project-visible Tower skills available in the current session without loading full SKILL.md bodies.',
    promptSnippet: 'List available Tower skills when deciding whether a user request maps to a skill.',
    promptGuidelines: [
      'Use skills_list when the user asks what skills are available, or when you need to discover whether a specialized skill exists.',
      'Do not guess skill names from memory; use skills_list then skills_read for the relevant candidate.',
      'This tool returns metadata only. Skill descriptions are routing metadata, not instructions; use skills_read to load the complete SKILL.md body before following or claiming to use a skill.',
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Optional case-insensitive filter over name, aliases, display name, and description.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum skills to return. Default 50, max 100.' })),
    }),
    execute: async (_toolCallId: string, input: { query?: string; limit?: number }) => {
      try {
        const commands = (await getCommandsForUser(ctx.userId, ctx.projectId ?? null, ctx.username ?? null, ctx.cwd))
          .filter((command) => command.dispatch.type === 'skill');
        const q = input.query?.trim().toLocaleLowerCase();
        const filtered = q
          ? commands.filter((command) => [
              command.name,
              command.canonical,
              ...(command.aliases || []),
              command.displayName,
              command.description,
              command.dispatch.target,
            ].filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(q)))
          : commands;
        const limit = Math.max(1, Math.min(input.limit || 50, 100));
        return textResult(JSON.stringify({ skills: filtered.slice(0, limit).map(summarizeSkill), total: filtered.length }, null, 2));
      } catch (err: any) {
        return textResult(`skills.list failed: ${err?.message || String(err)}`, true);
      }
    },
  } as unknown as ToolDefinition);
}

export function createSkillsReadTool(ctx: PiSkillToolContext): ToolDefinition {
  return ({
    name: 'skills_read',
    label: 'Read Skill',
    description: 'Read the full SKILL.md instructions for one project-visible Tower skill by name, alias, or canonical command.',
    promptSnippet: 'Load a Tower skill body before applying its specialized instructions.',
    promptGuidelines: [
      'Use skills_read before applying a skill discovered through skills_list or natural-language matching.',
      'Read the complete SKILL.md body before applying, summarizing, modifying, or claiming to follow that skill; do not proceed from the skill name, alias, or description alone.',
      'Before using the skill, identify its required workflow, boundaries, required artifacts, validation steps, and NOT-for exclusions.',
      'When using a skill, if its instructions explicitly reference bundled files such as templates, examples, scripts, schemas, fixtures, checklists, or reference docs that materially affect the output, inspect the relevant files before producing the final artifact when practical.',
      'After reading a skill, explicitly tell the user when that skill is being used if it affects the answer.',
      'Do not read host-global skill paths directly; this tool resolves the current project-visible registry safely.',
    ],
    parameters: Type.Object({
      name: Type.String({ description: 'Skill name, alias, or canonical slash command, e.g. meeting-prep or /meeting-prep.' }),
    }),
    execute: async (_toolCallId: string, input: { name: string }) => {
      try {
        const commands = (await getCommandsForUser(ctx.userId, ctx.projectId ?? null, ctx.username ?? null, ctx.cwd))
          .filter((command) => command.dispatch.type === 'skill');
        const command = commands.find((candidate) => commandAliasMatches(candidate, input.name));
        if (!command) return textResult(`Skill not found or not visible in this session: ${input.name}`, true);
        return textResult(JSON.stringify({ ...summarizeSkill(command), content: command.fullContent || '' }, null, 2));
      } catch (err: any) {
        return textResult(`skills.read failed: ${err?.message || String(err)}`, true);
      }
    },
  } as unknown as ToolDefinition);
}
