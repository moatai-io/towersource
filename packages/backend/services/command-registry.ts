/**
 * Command Registry — first-class slash command metadata for Tower.
 *
 * Owns: user-facing slash command entries across skills, native actions, and workflows.
 * Public API: skillCommandEntry(). See workspace/decisions/2026-06-29-slash-command-first-class-interface.md.
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import type { SkillScope } from '@tower/shared';

export type CommandKind = 'native' | 'skill' | 'workflow';
export type CommandRisk = 'low' | 'medium' | 'high' | 'destructive' | 'external-send' | 'deploy';
export type CommandUiAction =
  | { type: 'open_panel'; panel: 'agents' | 'skills' | 'tasks' | 'search'; params?: Record<string, unknown> }
  | { type: 'open_view'; view: 'work' | 'schedules' | 'projectFiles' | 'history' | 'kanban'; params?: Record<string, unknown> }
  | { type: 'prefill_input'; text: string; cursor?: 'end' }
  | { type: 'run_started'; runId?: string; message?: string }
  | { type: 'show_result'; surface?: string; message: string };

const COMMAND_RISKS: CommandRisk[] = ['low', 'medium', 'high', 'destructive', 'external-send', 'deploy'];

export interface CommandEntry {
  id: string;
  kind: CommandKind;
  /** Primary slash form, including leading slash. Kept compatible with legacy `name`. */
  canonical: `/${string}`;
  /** Backward-compatible primary command name consumed by existing clients. */
  name: `/${string}`;
  aliases: `/${string}`[];
  displayName?: string;
  /** Short UI-facing explanation for pickers. Falls back to description when absent. */
  summary?: string;
  description: string;
  argumentHint?: string;
  fullContent: string;
  source: 'commands' | 'skills' | 'native' | 'workflow';
  scope: SkillScope | 'system';
  risk: CommandRisk;
  dispatch: {
    type: CommandKind;
    target: string;
  };
  uiAction?: CommandUiAction;
}

const SLASH_PREFIX = /^\/+ */;

export interface ParsedSlashCommand {
  command: CommandEntry;
  matchedAlias: `/${string}`;
  args: string;
  canonicalInput: string;
}

/** Normalize a user-facing slash command alias while preserving subcommand spaces. */
export function normalizeSlashAlias(raw: string): `/${string}` | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.replace(SLASH_PREFIX, '').trim().replace(/\s+/g, ' ');
  if (!withoutPrefix) return null;
  return `/${withoutPrefix}`;
}

function commandAliasesForMatch(command: CommandEntry): `/${string}`[] {
  return uniqueSlashAliases([command.canonical, command.name, ...(command.aliases || [])]);
}

/** Parse slash input with longest-alias matching, so `/task list` wins over `/task`. */
export function parseSlashInput(input: string, commands: CommandEntry[]): ParsedSlashCommand | null {
  if (!input.trimStart().startsWith('/')) return null;
  const normalizedInput = normalizeSlashAlias(input);
  if (!normalizedInput) return null;
  const candidates = commands.flatMap((command) =>
    commandAliasesForMatch(command).map((alias) => ({ command, alias })),
  ).sort((a, b) => b.alias.length - a.alias.length);

  const inputLower = normalizedInput.toLocaleLowerCase();
  for (const candidate of candidates) {
    const aliasLower = candidate.alias.toLocaleLowerCase();
    if (inputLower !== aliasLower && !inputLower.startsWith(`${aliasLower} `)) continue;
    const args = normalizedInput.slice(candidate.alias.length).trim();
    const canonicalInput = `${candidate.command.canonical}${args ? ` ${args}` : ''}`;
    return {
      command: candidate.command,
      matchedAlias: candidate.alias,
      args,
      canonicalInput,
    };
  }
  return null;
}

export function canonicalizeSlashInput(input: string, commands: CommandEntry[]): string {
  return parseSlashInput(input, commands)?.canonicalInput ?? input;
}

export function uniqueSlashAliases(values: Array<string | undefined | null>): `/${string}`[] {
  const seen = new Set<string>();
  const aliases: `/${string}`[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = normalizeSlashAlias(value);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(normalized);
  }
  return aliases;
}

function parseFrontmatterField(content: string, field: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return '';
  const fm = fmMatch[1];

  const block = fm.match(new RegExp(`^${field}:\\s*[|>][^\n]*\n((?:[ \\t]+[^\n]*\n?)+)`, 'm'));
  if (block) {
    return block[1].replace(/^[ \t]+/gm, '').trim().split('\n')[0];
  }

  const single = fm.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (single) {
    const val = single[1].trim();
    if (val.startsWith('"') && val.endsWith('"')) return val.slice(1, -1);
    return val;
  }

  return '';
}

function cleanCommandDescription(description: string, content?: string): string {
  const fromFrontmatter = content ? parseFrontmatterField(content, 'description') : '';
  const raw = (fromFrontmatter || description || '').trim();
  const withoutFrontmatter = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const firstLine = withoutFrontmatter.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const compact = firstLine.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
}

function parseFrontmatterListField(content: string, field: string): string[] {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];

  const inline = fm.match(new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm'));
  if (inline) {
    return inline[1]
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  const block = fm.match(new RegExp(`^${field}:\\s*\n((?:[ \\t]+-\\s*[^\n]+\n?)+)`, 'm'));
  if (block) {
    return block[1]
      .split('\n')
      .map((line) => line.trim().replace(/^-\s*/, '').trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  const single = fm.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (single) {
    return single[1]
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  return [];
}

export function nativeCommandEntries(): CommandEntry[] {
  return [
    {
      id: 'workflow:agent',
      kind: 'workflow',
      canonical: '/agent',
      name: '/agent',
      aliases: uniqueSlashAliases(['/agents', '/에이전트']),
      displayName: '에이전트',
      description: '프로젝트 에이전트를 설정하거나 실행합니다.',
      argumentHint: '[agent-id] [task]',
      fullContent: '',
      source: 'workflow',
      scope: 'system',
      risk: 'medium',
      dispatch: { type: 'workflow', target: 'agent' },
      uiAction: { type: 'open_panel', panel: 'agents' },
    },
    {
      id: 'native:skills',
      kind: 'native',
      canonical: '/skills',
      name: '/skills',
      aliases: uniqueSlashAliases(['/skill', '/스킬', '/스킬목록']),
      displayName: '스킬',
      description: '사용 가능한 스킬 목록과 시작 화면을 엽니다.',
      argumentHint: '[skill-name]',
      fullContent: '',
      source: 'native',
      scope: 'system',
      risk: 'low',
      dispatch: { type: 'native', target: 'skills.open' },
      uiAction: { type: 'open_panel', panel: 'skills' },
    },
    {
      id: 'native:task-list',
      kind: 'native',
      canonical: '/task list',
      name: '/task list',
      aliases: uniqueSlashAliases(['/tasks', '/태스크목록', '/할일목록', '/작업목록']),
      displayName: '태스크 목록',
      description: '현재 접근 가능한 Tower 태스크 목록을 조회합니다.',
      argumentHint: '[filter]',
      fullContent: '',
      source: 'native',
      scope: 'system',
      risk: 'low',
      dispatch: { type: 'native', target: 'task.list' },
      uiAction: { type: 'open_view', view: 'work' },
    },
    {
      id: 'native:compact',
      kind: 'native',
      canonical: '/compact',
      name: '/compact',
      aliases: uniqueSlashAliases(['/압축', '/컨텍스트압축']),
      displayName: '컨텍스트 압축',
      description: '현재 세션의 대화 컨텍스트를 압축합니다. 엔진별 실제 실행 지원은 별도 dispatch 단계에서 처리합니다.',
      fullContent: '',
      source: 'native',
      scope: 'system',
      risk: 'medium',
      dispatch: { type: 'native', target: 'session.compact' },
    },
  ];
}

export interface WorkflowCommandManifest {
  id: string;
  canonical?: string;
  aliases?: string[];
  displayName?: string;
  summary?: string;
  shortDescription?: string;
  description: string;
  argumentHint?: string;
  risk?: CommandRisk;
  dispatch?: {
    target?: string;
  };
  target?: string;
}

function parseWorkflowManifest(content: string, filePath: string): WorkflowCommandManifest {
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.json' ? JSON.parse(content) : YAML.parse(content);
  if (!parsed || typeof parsed !== 'object') throw new Error('workflow command manifest must be an object');
  return parsed as WorkflowCommandManifest;
}

function validCommandRisk(value: unknown): value is CommandRisk {
  return typeof value === 'string' && COMMAND_RISKS.includes(value as CommandRisk);
}

export function workflowCommandEntry(args: {
  manifest: WorkflowCommandManifest;
  content: string;
  scope: SkillScope | 'system';
  sourcePath?: string;
}): CommandEntry {
  const { manifest } = args;
  if (!manifest.id || !/^[a-z0-9][a-z0-9:.-]{0,127}$/.test(manifest.id)) {
    throw new Error(`Invalid workflow command id${args.sourcePath ? ` in ${args.sourcePath}` : ''}: use stable ASCII slug`);
  }
  if (!manifest.description || typeof manifest.description !== 'string') {
    throw new Error(`Workflow command ${manifest.id} must include description`);
  }

  const canonical = normalizeSlashAlias(manifest.canonical || `/${manifest.id}`);
  if (!canonical) throw new Error(`Workflow command ${manifest.id} must include a valid canonical slash command`);
  const aliases = uniqueSlashAliases([canonical, ...(manifest.aliases || [])]);
  const target = manifest.dispatch?.target || manifest.target || manifest.id;

  return {
    id: `workflow:${manifest.id}`,
    kind: 'workflow',
    canonical,
    name: canonical,
    aliases,
    displayName: manifest.displayName,
    summary: manifest.summary || manifest.shortDescription,
    description: manifest.description,
    argumentHint: manifest.argumentHint,
    fullContent: args.content,
    source: 'workflow',
    scope: args.scope,
    risk: validCommandRisk(manifest.risk) ? manifest.risk : 'medium',
    dispatch: {
      type: 'workflow',
      target,
    },
  };
}

function isWorkflowCommandManifestFile(fileName: string): boolean {
  return /(^|\.)command\.(json|ya?ml)$/i.test(fileName) || /\.(json|ya?ml)$/i.test(fileName);
}

export function loadWorkflowCommandEntries(rootDir?: string, scope: SkillScope | 'system' = 'project'): CommandEntry[] {
  if (!rootDir) return [];
  const commandRoots = [
    // Project-authored commands belong beside `skills/` in the visible project tree.
    path.join(rootDir, 'commands'),
    // Compatibility locations remain readable, but never outrank the canonical root.
    path.join(rootDir, '.project', 'commands'),
    path.join(rootDir, '.tower', 'commands'),
  ];

  const entries: CommandEntry[] = [];
  const seen = new Set<string>();
  for (const commandsDir of commandRoots) {
    if (!fs.existsSync(commandsDir)) continue;
    const files = fs.readdirSync(commandsDir, { withFileTypes: true })
      .filter((item) => item.isFile() && isWorkflowCommandManifestFile(item.name))
      .map((item) => item.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of files) {
      const filePath = path.join(commandsDir, fileName);
      const content = fs.readFileSync(filePath, 'utf8');
      try {
        const entry = workflowCommandEntry({
          manifest: parseWorkflowManifest(content, filePath),
          content,
          scope,
          sourcePath: filePath,
        });
        const collidingAlias = entry.aliases.find((alias) => seen.has(alias));
        if (seen.has(entry.canonical) || collidingAlias) {
          console.warn(`[commands] skipping conflicting workflow command ${filePath}: ${collidingAlias || entry.canonical} is already registered`);
          continue;
        }
        seen.add(entry.canonical);
        for (const alias of entry.aliases) seen.add(alias);
        entries.push(entry);
      } catch (err: any) {
        console.warn(`[commands] skipping invalid workflow command manifest ${filePath}: ${err?.message || err}`);
      }
    }
  }
  return entries;
}

export function skillCommandEntry(args: {
  name: string;
  description: string;
  content: string;
  scope: SkillScope;
}): CommandEntry {
  const displayName = parseFrontmatterField(args.content, 'display-name')
    || parseFrontmatterField(args.content, 'displayName')
    || undefined;
  const argumentHint = parseFrontmatterField(args.content, 'argument-hint')
    || parseFrontmatterField(args.content, 'argumentHint')
    || undefined;
  const summary = parseFrontmatterField(args.content, 'summary')
    || parseFrontmatterField(args.content, 'short-description')
    || parseFrontmatterField(args.content, 'shortDescription')
    || undefined;
  const aliases = uniqueSlashAliases([
    args.name,
    ...(displayName ? [displayName] : []),
    ...parseFrontmatterListField(args.content, 'aliases'),
    ...parseFrontmatterListField(args.content, 'slash-aliases'),
    ...parseFrontmatterListField(args.content, 'slashAliases'),
  ]);
  const canonical = normalizeSlashAlias(args.name) ?? `/${args.name}`;

  return {
    id: args.name,
    kind: 'skill',
    canonical,
    name: canonical,
    aliases,
    displayName,
    summary: summary ? cleanCommandDescription(summary) : undefined,
    description: cleanCommandDescription(args.description, args.content),
    argumentHint,
    fullContent: args.content,
    source: 'skills',
    scope: args.scope,
    risk: 'medium',
    dispatch: {
      type: 'skill',
      target: args.name,
    },
  };
}
